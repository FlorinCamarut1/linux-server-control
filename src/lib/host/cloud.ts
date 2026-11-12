// Cloud backup: the whole dashboard (its DATA_DIR), encrypted with a passphrase,
// uploaded with rclone to OneDrive, Google Drive or Proton Drive, by hand or on
// a schedule, keeping the latest few. rclone runs in the dashboard's container,
// next to the data; it keeps the cloud accounts' tokens in cloud-rclone.conf in
// DATA_DIR and renews them there.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { DATA, audit, emitDashboardEvent, read, save } from "./store";
import { syncCron } from "./cron";
import { oneLine } from "./records";
import { t } from "../i18n";

export type DestinationType = "onedrive" | "drive" | "protondrive";
export const DESTINATION_TYPES: Record<DestinationType, string> = { onedrive: "OneDrive", drive: "Google Drive", protondrive: "Proton Drive" };
type LastBackup = { at: number; ok: boolean; file?: string; bytes?: number; error?: string };
export type Destination = { id: string; type: DestinationType; name: string; folder: string; enabled: boolean; account?: string; last?: LastBackup };
export type BackupSchedule = { enabled: boolean; frequency: "daily" | "weekly"; hour: number; weekday: number; timeZone: string; keep: number };
type CloudSettings = { destinations: Destination[]; schedule: BackupSchedule; passphrase?: string; lastScheduled?: number };
const DEFAULT_SCHEDULE: BackupSchedule = { enabled: false, frequency: "daily", hour: 3, weekday: 0, timeZone: "UTC", keep: 14 };
const settings = (): CloudSettings => {
  const stored = read<Partial<CloudSettings>>("cloud", {});
  return { destinations: stored.destinations ?? [], schedule: { ...DEFAULT_SCHEDULE, ...stored.schedule }, passphrase: stored.passphrase, lastScheduled: stored.lastScheduled };
};
const saveSettings = (value: CloudSettings) => save("cloud", value);
// What the browser is told: never the passphrase, tokens or passwords.
export function cloudState() {
  const { destinations, schedule, passphrase } = settings();
  return { destinations, schedule, passphraseSet: !!passphrase, running: !!busy.lscBackup };
}

// ---- rclone and other programs in the container ----
const RCLONE_CONFIG = () => path.join(DATA, "cloud-rclone.conf");
// Runs a program of the container (not on the managed server).
function local(command: string, args: string[], input?: Buffer | string, timeout = 10 * 60 * 1000) {
  return new Promise<Buffer>((resolve, reject) => {
    const child = execFile(command, args, { encoding: "buffer", timeout, maxBuffer: 2 ** 30, env: { ...process.env, RCLONE_CACHE_DIR: "/tmp/rclone-cache" } }, (error, stdout, stderr) => {
      if (!error) return resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ""));
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return reject(Error(t("{program} is not installed in the dashboard's container", { program: command })));
      // rclone writes "2026/11/12 16:42:17 ERROR : what : why"; the why is shown.
      const lines = String(stderr ?? "").split("\n").map((line) => line.replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d \w+ ?: ?/, "").trim()).filter(Boolean);
      const reason = lines.filter((line) => !/^(NOTICE|INFO)\b|Config file .* not found/.test(line)).pop();
      reject(Error(reason || (error.killed ? t("{program} took too long", { program: command }) : t("{program} failed", { program: command }))));
    });
    child?.stdin?.on("error", () => {});
    child?.stdin?.end(input ?? "");
  });
}
const rclone = (args: string[], input?: Buffer | string, timeout?: number) => local("rclone", ["--config", RCLONE_CONFIG(), "--low-level-retries", "3", ...args], input, timeout);

// cloud-rclone.conf, an INI file with one section per destination. rclone
// writes renewed tokens into it, so it is read again before every change.
function readConfig() {
  const sections = new Map<string, [string, string][]>();
  let current: [string, string][] | undefined;
  const text = existsSync(RCLONE_CONFIG()) ? readFileSync(RCLONE_CONFIG(), "utf8") : "";
  for (const line of text.split(/\r?\n/)) {
    const section = /^\[(.+)\]$/.exec(line.trim());
    if (section) sections.set(section[1], (current = []));
    else if (current && line.includes("=")) current.push([line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()]);
  }
  return sections;
}
function writeConfig(sections: Map<string, [string, string][]>) {
  const text = [...sections].map(([name, entries]) => `[${name}]\n${entries.map(([key, value]) => `${key} = ${value}`).join("\n")}\n`).join("\n");
  writeFileSync(RCLONE_CONFIG() + ".tmp", text, { mode: 0o600 });
  renameSync(RCLONE_CONFIG() + ".tmp", RCLONE_CONFIG());
}
function setSection(name: string, entries: [string, string][] | undefined) {
  const sections = readConfig();
  if (entries) sections.set(name, entries); else sections.delete(name);
  writeConfig(sections);
}
const remote = (destination: Destination, file = "") => `${destination.id}:${[destination.folder, file].filter(Boolean).join("/")}`;

// ---- destinations ----
// What `rclone authorize` prints ends with the token, a JSON object, between
// "--->" and "<---End paste"; the whole output or the object alone may be pasted.
export function tokenFrom(pasted: string) {
  const start = pasted.indexOf("{"), end = pasted.lastIndexOf("}");
  try {
    const token = JSON.parse(pasted.slice(start, end + 1));
    if (token && typeof token.access_token === "string" && typeof token.refresh_token === "string") return token as { access_token: string; refresh_token: string; [key: string]: unknown };
  } catch {}
  throw Error(t("Paste what rclone authorize printed: the text between ---> and <---End paste"));
}
const FOLDER = /^[\w .()-]+(\/[\w .()-]+)*$/;
function cleanFolder(value: unknown) {
  const folder = oneLine(value, 200).replace(/^\/+|\/+$/g, "") || "LinuxServerControl";
  if (!FOLDER.test(folder) || folder.split("/").some((part) => part.trim() === "." || part.trim() === ".."))
    throw Error(t("Use a folder name of letters, digits, spaces, dots, dashes and slashes"));
  return folder;
}
// OneDrive needs to know which drive: the account's own, asked of Microsoft
// with the token that was just made.
async function oneDrive(token: { access_token: string }) {
  let answer: Response;
  try {
    answer = await fetch("https://graph.microsoft.com/v1.0/me/drive", { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(20000) });
  } catch {
    throw Error(t("Microsoft could not be reached to find the OneDrive"));
  }
  if (answer.status === 401) throw Error(t("This code has expired. Run rclone authorize again and paste the new code."));
  if (!answer.ok) throw Error(t("Microsoft did not give the OneDrive ({status})", { status: answer.status }));
  const drive = await answer.json() as { id?: string; driveType?: string; owner?: { user?: { displayName?: string; email?: string } } };
  if (!drive.id) throw Error(t("Microsoft did not give the OneDrive ({status})", { status: answer.status }));
  return { id: drive.id, type: drive.driveType === "business" || drive.driveType === "documentLibrary" ? drive.driveType : "personal", owner: drive.owner?.user?.email || drive.owner?.user?.displayName || "" };
}
const obscure = async (secret: string) => (await local("rclone", ["obscure", "-"], secret)).toString().trim();
export async function saveDestination(input: Record<string, unknown>) {
  const all = settings();
  const existing = all.destinations.find((item) => item.id === input.id);
  const name = oneLine(input.name, 60);
  if (!name) throw Error(t("Enter a name"));
  const folder = cleanFolder(input.folder);
  // A saved destination changes its name, folder and whether it is used; its
  // account stays, and is changed by adding the destination again.
  if (existing) {
    const updated = { ...existing, name, folder, enabled: input.enabled !== false && input.enabled !== "false" };
    if (folder !== existing.folder) await rclone(["mkdir", remote(updated)], undefined, 60000);
    saveSettings({ ...all, destinations: all.destinations.map((item) => (item.id === existing.id ? updated : item)) });
    audit(`cloud destination changed ${name}`);
    return updated;
  }
  const type = input.type as DestinationType;
  if (!(type in DESTINATION_TYPES)) throw Error(t("Choose a cloud service"));
  const destination: Destination = { id: `lsc${randomBytes(6).toString("hex")}`, type, name, folder, enabled: true };
  let entries: [string, string][];
  if (type === "protondrive") {
    const username = oneLine(input.username, 200), password = String(input.password ?? "");
    if (!username || !password) throw Error(t("Enter the Proton account's email and password"));
    const mailbox = String(input.mailboxPassword ?? ""), code = oneLine(input.code, 12);
    entries = [["type", "protondrive"], ["username", username], ["password", await obscure(password)],
      ...(mailbox ? [["mailbox_password", await obscure(mailbox)] as [string, string]] : []), ...(code ? [["2fa", code] as [string, string]] : [])];
    destination.account = username;
  } else {
    const token = tokenFrom(String(input.token ?? ""));
    if (type === "onedrive") {
      const drive = await oneDrive(token);
      entries = [["type", "onedrive"], ["token", JSON.stringify(token)], ["drive_id", drive.id], ["drive_type", drive.type], ["region", "global"]];
      destination.account = drive.owner;
    } else entries = [["type", "drive"], ["scope", "drive.file"], ["token", JSON.stringify(token)]];
  }
  setSection(destination.id, entries);
  // Signing in, and making the folder, show that it works before it is saved.
  try {
    await rclone(["mkdir", remote(destination)], undefined, 120000);
    await rclone(["lsjson", "--files-only", remote(destination)], undefined, 120000);
  } catch (error) {
    setSection(destination.id, undefined);
    throw Error(t("{service} did not accept the connection: {error}", { service: DESTINATION_TYPES[type], error: error instanceof Error ? error.message : "" }));
  }
  // A Proton two-factor code is used once; rclone keeps the session it opened.
  if (type === "protondrive") {
    const sections = readConfig(), section = sections.get(destination.id);
    if (section) { sections.set(destination.id, section.filter(([key]) => key !== "2fa")); writeConfig(sections); }
  }
  saveSettings({ ...settings(), destinations: [...settings().destinations, destination] });
  audit(`cloud destination added ${name} (${DESTINATION_TYPES[type]})`);
  return destination;
}
// Signing in to OneDrive or Google Drive from the dashboard. `rclone authorize`
// runs in the container and waits on 127.0.0.1:53682 for the browser to come
// back from the sign-in with a code. The browser is on another computer, so it
// lands on a page that cannot be reached there; its address, with the code, is
// pasted into the dashboard, which hands it to the waiting rclone. rclone then
// trades the code for a token with its own app, and prints the token.
const AUTH_PORT = "127.0.0.1:53682";
// Google Drive limited to the files rclone makes: {"scope":"drive.file"}.
const DRIVE_FILE_SCOPE = "eyJzY29wZSI6ImRyaXZlLmZpbGUifQ";
const AUTH_WAIT_MS = 10 * 60 * 1000;
type Authorization = { type: "onedrive" | "drive"; state: string; child: ChildProcess; stdout: string; stderr: string; ended: Promise<number | null>; timer: ReturnType<typeof setTimeout> };
const signIn = globalThis as { lscCloudSignIn?: Authorization };
export function stopSignIn() {
  const pending = signIn.lscCloudSignIn;
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.child.kill();
  signIn.lscCloudSignIn = undefined;
}
// A value after a while, without keeping the process alive for it.
const after = <T,>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms).unref?.());
const reason = (stderr: string) => stderr.split("\n").map((line) => line.replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d \w+ ?: ?/, "").replace(/^Fatal error: /, "").trim()).filter(Boolean).pop() || "";
// Starts a sign-in and gives the address of the service's sign-in page.
export async function startSignIn(type: unknown) {
  if (type !== "onedrive" && type !== "drive") throw Error(t("Choose a cloud service"));
  stopSignIn();
  const child = spawn("rclone", ["authorize", type, ...(type === "drive" ? [DRIVE_FILE_SCOPE] : []), "--auth-no-open-browser"], {
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, RCLONE_CACHE_DIR: "/tmp/rclone-cache", RCLONE_CONFIG: "/tmp/rclone-authorize.conf" },
  });
  const pending: Authorization = { type, state: "", child, stdout: "", stderr: "", ended: new Promise((resolve) => { child.on("close", resolve); child.on("error", () => resolve(null)); }), timer: setTimeout(stopSignIn, AUTH_WAIT_MS) };
  pending.timer.unref?.();
  child.stdout?.on("data", (chunk) => { pending.stdout += chunk; });
  child.stderr?.on("data", (chunk) => { pending.stderr += chunk; });
  signIn.lscCloudSignIn = pending;
  try {
    return await signInPage(pending);
  } catch (error) {
    // A sign-in that could not start must not keep rclone, or its port, busy.
    stopSignIn();
    throw error;
  }
}
async function signInPage(pending: Authorization) {
  const { child } = pending;
  // rclone names its own address for the sign-in, with the state it expects back.
  const link = await Promise.race([
    new Promise<string>((resolve) => {
      const look = () => {
        const found = /https?:\/\/127\.0\.0\.1:53682\/auth\?state=([\w-]+)/.exec(pending.stderr);
        if (found) { child.stderr?.off("data", look); resolve(found[0]); }
      };
      child.stderr?.on("data", look);
      look();
    }),
    pending.ended.then(() => ""),
    after(20000, ""),
  ]);
  if (!link) throw Error(t("The sign-in could not be started: {error}", { error: reason(pending.stderr) || t("rclone did not answer") }));
  pending.state = new URL(link).searchParams.get("state") || "";
  // That address redirects to the service's sign-in page, which is what the browser opens.
  const answer = await fetch(link, { redirect: "manual", signal: AbortSignal.timeout(10000) });
  const target = answer.headers.get("location");
  if (!target || !/^https:\/\//.test(target)) throw Error(t("The sign-in could not be started: {error}", { error: `HTTP ${answer.status}` }));
  return target;
}
// Finishes a sign-in with the address the browser came back to, and adds the destination.
export async function finishSignIn(input: Record<string, unknown>) {
  const pending = signIn.lscCloudSignIn;
  if (!pending || pending.type !== input.type) throw Error(t("Sign in again: this sign-in has ended"));
  let address: URL;
  try {
    const text = String(input.address ?? "").trim();
    address = new URL(/^https?:\/\//.test(text) ? text : `http://${text}`);
  } catch {
    throw Error(t("Paste the whole address of the page that could not be reached"));
  }
  const params = address.searchParams;
  if (!["127.0.0.1", "localhost"].includes(address.hostname) || address.port !== "53682" || (!params.get("code") && !params.get("error")))
    throw Error(t("Paste the whole address of the page that could not be reached"));
  // rclone gives up on an address with another state, so it is not passed on.
  if (params.get("state") !== pending.state) throw Error(t("This address belongs to an older sign-in. Sign in again and paste the new address."));
  if (params.get("error")) {
    stopSignIn();
    throw Error(t("Access was not allowed ({error})", { error: params.get("error_description") || params.get("error") || "" }));
  }
  try {
    await fetch(`http://${AUTH_PORT}/?${params}`, { signal: AbortSignal.timeout(20000) });
    const code = await Promise.race([pending.ended, after(60000, null)]);
    if (code !== 0) throw Error(t("{service} did not give access: {error}", { service: DESTINATION_TYPES[pending.type], error: reason(pending.stderr) || t("rclone did not answer") }));
    return await saveDestination({ ...input, type: pending.type, token: pending.stdout });
  } finally {
    stopSignIn();
  }
}
// The backups stay in the cloud; only the dashboard forgets the account.
export function deleteDestination(id: string) {
  const all = settings();
  const destination = all.destinations.find((item) => item.id === id);
  if (!destination) throw Error(t("Cloud destination not found"));
  setSection(id, undefined);
  saveSettings({ ...all, destinations: all.destinations.filter((item) => item.id !== id) });
  audit(`cloud destination removed ${destination.name}`);
}
function findDestination(id: unknown) {
  const destination = settings().destinations.find((item) => item.id === id);
  if (!destination) throw Error(t("Cloud destination not found"));
  return destination;
}

// ---- the schedule ----
export function saveBackupSettings(input: Record<string, unknown>) {
  const all = settings();
  const hour = Number(input.hour), weekday = Number(input.weekday), keep = Number(input.keep);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw Error(t("Choose a valid time"));
  if (!Number.isInteger(keep) || keep < 1 || keep > 365) throw Error(t("Keep between 1 and 365 backups"));
  const timeZone = oneLine(input.timeZone, 64) || "UTC";
  try { new Intl.DateTimeFormat("en", { timeZone }); } catch { throw Error(t("Choose a valid time")); }
  const passphrase = String(input.passphrase ?? "");
  if (passphrase && (passphrase.length < 12 || passphrase.length > 1024)) throw Error(t("The passphrase must have at least 12 characters"));
  const enabled = input.enabled === true || input.enabled === "true";
  if (enabled && !passphrase && !all.passphrase) throw Error(t("Set an encryption passphrase first"));
  const schedule: BackupSchedule = { enabled, frequency: input.frequency === "weekly" ? "weekly" : "daily", hour, weekday, timeZone, keep };
  // A schedule that is turned on starts with the next time it names, not with one already past.
  const lastScheduled = enabled && !all.schedule.enabled ? Date.now() : all.lastScheduled;
  saveSettings({ ...all, schedule, ...(passphrase ? { passphrase } : {}), lastScheduled });
  audit(passphrase ? "cloud backup settings saved, passphrase changed" : "cloud backup settings saved");
}
// The wall clock of a time zone at a moment, as if it were UTC.
function wall(at: number, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
    .formatToParts(at).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}
// The moment a day's wall-clock hour falls on in a time zone.
function at(year: number, month: number, day: number, hour: number, timeZone: string) {
  const guess = Date.UTC(year, month, day, hour);
  let moment = guess - (wall(guess, timeZone) - guess);
  moment = guess - (wall(moment, timeZone) - moment);
  return moment;
}
// The latest moment the schedule names at or before `now`.
export function lastSlot(schedule: BackupSchedule, now = Date.now()) {
  for (let back = 0; back <= 8; back++) {
    const day = new Date(wall(now, schedule.timeZone) - back * 86400000);
    if (schedule.frequency === "weekly" && day.getUTCDay() !== schedule.weekday) continue;
    const moment = at(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), schedule.hour, schedule.timeZone);
    if (moment <= now) return moment;
  }
  return undefined;
}
// Called every few minutes by the server: makes the backup the schedule is due for.
export async function runDueBackup(now = Date.now()) {
  const all = settings();
  if (!all.schedule.enabled || !all.passphrase || !all.destinations.some((item) => item.enabled)) return false;
  const slot = lastSlot(all.schedule, now);
  if (slot === undefined || (all.lastScheduled ?? 0) >= slot) return false;
  saveSettings({ ...all, lastScheduled: now });
  await backupNow().catch(() => {});
  return true;
}

// ---- making a backup ----
// Left out: the browsers' sign-ins, a pending enrollment, the cloud settings
// themselves (the passphrase and tokens) and unfinished writes.
const LEFT_OUT = new Set(["sessions.json", "enroll.json", "cloud.json", "cloud-rclone.conf"]);
const leftOut = (relative: string) => LEFT_OUT.has(relative) || relative.endsWith(".tmp") || relative.startsWith(".restore-");
const BACKUP_NAME = /^lsc-backup-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.lscb$/;
const MAGIC = Buffer.from("LSC-BACKUP-1\n");
const key = (passphrase: string, salt: Buffer) => new Promise<Buffer>((resolve, reject) =>
  scrypt(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derived) => (error ? reject(error) : resolve(derived))));
export async function encrypt(data: Buffer, passphrase: string) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await key(passphrase, salt), iv);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, body, cipher.getAuthTag()]);
}
export async function decrypt(file: Buffer, passphrase: string) {
  if (file.length < MAGIC.length + 44 || !file.subarray(0, MAGIC.length).equals(MAGIC)) throw Error(t("This file is not a backup of the dashboard"));
  const salt = file.subarray(MAGIC.length, MAGIC.length + 16), iv = file.subarray(MAGIC.length + 16, MAGIC.length + 28);
  const decipher = createDecipheriv("aes-256-gcm", await key(passphrase, salt), iv);
  decipher.setAuthTag(file.subarray(file.length - 16));
  try {
    return Buffer.concat([decipher.update(file.subarray(MAGIC.length + 28, file.length - 16)), decipher.final()]);
  } catch {
    throw Error(t("Wrong passphrase, or the backup is damaged"));
  }
}
// DATA_DIR as a gzip-compressed tar archive; the container has tar but no gzip.
async function archive() {
  const files = readdirSync(DATA).filter((name) => !leftOut(name));
  return gzipSync(await local("tar", ["-cf", "-", "-C", DATA, "--exclude=*.tmp", "--", ...files]));
}
const busy = globalThis as { lscBackup?: Promise<LastBackup[]> };
// Makes one backup and uploads it to every destination in use, or to one;
// then deletes the oldest beyond the number to keep.
export function backupNow(only?: string) {
  if (busy.lscBackup) throw Error(t("A backup is already running"));
  const all = settings();
  if (!all.passphrase) throw Error(t("Set an encryption passphrase first"));
  const targets = all.destinations.filter((item) => (only ? item.id === only : item.enabled));
  if (!targets.length) throw Error(t("Add a cloud destination first"));
  const work = (async () => {
    const file = `lsc-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.lscb`;
    const sealed = await encrypt(await archive(), all.passphrase!);
    const results: LastBackup[] = [];
    for (const destination of targets) {
      let last: LastBackup;
      try {
        await rclone(["rcat", remote(destination, file)], sealed);
        await prune(destination, all.schedule.keep);
        last = { at: Date.now(), ok: true, file, bytes: sealed.length };
        audit(`cloud backup ${file} uploaded to ${destination.name}`);
      } catch (error) {
        last = { at: Date.now(), ok: false, error: error instanceof Error ? error.message : String(error) };
        audit(`cloud backup to ${destination.name} failed: ${last.error}`);
        emitDashboardEvent(() => ({ type: "backup-failed", severity: "critical", title: t("Cloud backup failed: {name}", { name: destination.name }), message: last.error ?? "" }));
      }
      results.push(last);
      const now = settings();
      saveSettings({ ...now, destinations: now.destinations.map((item) => (item.id === destination.id ? { ...item, last } : item)) });
    }
    return results;
  })();
  busy.lscBackup = work.finally(() => { busy.lscBackup = undefined; });
  return busy.lscBackup;
}
type CloudFile = { Name: string; Size: number; ModTime: string; IsDir?: boolean };
export async function listBackups(id: unknown) {
  const destination = findDestination(id);
  let files: CloudFile[];
  try {
    files = JSON.parse((await rclone(["lsjson", "--files-only", "--no-mimetype", remote(destination)], undefined, 120000)).toString() || "[]");
  } catch (error) {
    // A folder deleted in the cloud is a folder without backups.
    if (error instanceof Error && /directory not found|not found/i.test(error.message)) return [];
    throw error;
  }
  return files.filter((item) => !item.IsDir && BACKUP_NAME.test(item.Name))
    .map((item) => ({ name: item.Name, bytes: item.Size, at: Date.parse(item.ModTime) || 0 }))
    .sort((a, b) => b.name.localeCompare(a.name));
}
async function prune(destination: Destination, keep: number) {
  const backups = await listBackups(destination.id);
  for (const old of backups.slice(keep)) await rclone(["deletefile", remote(destination, old.name)], undefined, 120000);
}
export async function deleteBackup(id: unknown, name: unknown) {
  const destination = findDestination(id);
  if (typeof name !== "string" || !BACKUP_NAME.test(name)) throw Error(t("Backup not found"));
  await rclone(["deletefile", remote(destination, name)], undefined, 120000);
  audit(`cloud backup ${name} deleted from ${destination.name}`);
}

// ---- restoring ----
const filesIn = (folder: string, base = folder): string[] => readdirSync(folder).flatMap((name) => {
  const full = path.join(folder, name);
  return statSync(full).isDirectory() ? filesIn(full, base) : [path.relative(base, full).split(path.sep).join("/")];
});
// Replaces the dashboard's data with a backup's. The browsers that are signed
// in stay authorized, also those the backup does not know, so that whoever
// restores is not locked out; the cloud settings stay as they are.
export async function restoreBackup(id: unknown, name: unknown, passphrase?: string) {
  const destination = findDestination(id);
  if (typeof name !== "string" || !BACKUP_NAME.test(name)) throw Error(t("Backup not found"));
  const secret = passphrase || settings().passphrase;
  if (!secret) throw Error(t("Set an encryption passphrase first"));
  const contents = gunzipSync(await decrypt(await rclone(["cat", remote(destination, name)]), secret));
  const staging = path.join(DATA, `.restore-${randomBytes(6).toString("hex")}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    await local("tar", ["-xf", "-", "-C", staging, "--no-same-owner", "--no-same-permissions"], contents);
    const restored = filesIn(staging).filter((relative) => !leftOut(relative));
    if (!restored.includes("config.json")) throw Error(t("This file is not a backup of the dashboard"));
    const devices = read<Record<string, unknown>>("devices", {});
    const previousUsers = read<{ runAs?: string }[]>("schedules", []).map((item) => (item.runAs === "root" ? "root" : "user"));
    // Records the backup does not have, such as one added since, go too.
    for (const record of readdirSync(DATA))
      if (record.endsWith(".json") && !leftOut(record) && !record.startsWith("cron-backup-") && !restored.includes(record)) rmSync(path.join(DATA, record), { force: true });
    for (const relative of restored) {
      const target = path.join(DATA, ...relative.split("/"));
      mkdirSync(path.dirname(target), { recursive: true });
      renameSync(path.join(staging, ...relative.split("/")), target);
    }
    save("devices", { ...read<Record<string, unknown>>("devices", {}), ...devices });
    audit(`cloud backup ${name} restored from ${destination.name}`);
    // The crontabs follow the restored schedules, and lose those it does not have.
    await syncCron(previousUsers as ("user" | "root")[]).catch((error) => {
      throw Error(t("The data was restored, but the schedules could not be written to the server: {error}", { error: error instanceof Error ? error.message : "" }));
    });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
