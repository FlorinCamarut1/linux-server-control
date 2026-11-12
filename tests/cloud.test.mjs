import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { loadServer, plain } from "./harness.mjs";

// An rclone whose remotes are folders here: "lscabc:Backups/file" is
// <cloud>/lscabc/Backups/file. Every call is recorded; `fail` makes the
// commands it names fail. tar runs for real.
function fakeCloud() {
  const cloud = mkdtempSync(path.join(tmpdir(), "lsc-cloud-"));
  const calls = [];
  const fail = new Set();
  const where = (spec) => {
    const at = spec.indexOf(":");
    return path.join(cloud, spec.slice(0, at), ...spec.slice(at + 1).split("/").filter(Boolean));
  };
  const host = (argv, input) => {
    if (argv[0] === "tar") {
      const result = spawnSync("tar", argv.slice(1), { input: input ?? "" });
      return { stdout: result.stdout, stderr: result.stderr.toString(), code: result.status ?? 1 };
    }
    if (argv[0] !== "rclone") return { stdout: "" };
    if (argv[1] === "obscure") { calls.push({ command: "obscure", input: String(input) }); return { stdout: `obscured(${String(input)})\n` }; }
    const [command, ...rest] = argv.slice(5);
    const target = rest.at(-1);
    calls.push({ command, target, argv });
    if (fail.has(command)) return { code: 1, stderr: `2026/11/12 16:42:17 ERROR : ${target}: ${command} refused by the cloud` };
    if (command === "mkdir") { mkdirSync(where(target), { recursive: true }); return { stdout: "" }; }
    if (command === "lsjson") {
      if (!existsSync(where(target))) return { code: 3, stderr: "ERROR : : error listing: directory not found" };
      return { stdout: JSON.stringify(readdirSync(where(target)).map((name) => ({ Name: name, Size: readFileSync(path.join(where(target), name)).length, ModTime: "2026-11-12T16:00:00Z", IsDir: false }))) };
    }
    if (command === "rcat") { mkdirSync(path.dirname(where(target)), { recursive: true }); writeFileSync(where(target), input); return { stdout: "" }; }
    if (command === "cat") return { stdout: readFileSync(where(target)) };
    if (command === "deletefile") { rmSync(where(target)); return { stdout: "" }; }
    return { code: 1, stderr: `unknown ${command}` };
  };
  const folder = (destination) => path.join(cloud, destination.id, destination.folder);
  return { cloud, calls, fail, host, files: (destination) => readdirSync(folder(destination)).sort(), stored: (destination, name) => readFileSync(path.join(folder(destination), name)) };
}
const TOKEN = '{"access_token":"ya29.access","token_type":"Bearer","refresh_token":"1//refresh","expiry":"2026-11-12T17:42:17Z"}';
const AUTHORIZE_OUTPUT = `2026/11/12 16:42:17 NOTICE: Got code\nPaste the following into your remote machine --->\n${TOKEN}\n<---End paste\n`;
async function withDrive(options = {}) {
  const cloud = fakeCloud();
  const loaded = loadServer({ host: cloud.host, ...options });
  const { server, data } = loaded;
  writeFileSync(path.join(data, "config.json"), JSON.stringify({ username: "admin", salt: "00", password: "hash" }));
  server.save("scripts", [{ id: "a", name: "Backup", path: "/srv/scripts/a.sh", cron: "" }]);
  server.saveBackupSettings({ enabled: "false", frequency: "daily", hour: "3", weekday: "0", keep: "14", timeZone: "Europe/Bucharest", passphrase: "correct horse battery" });
  const destination = plain(await server.saveDestination({ type: "drive", name: "My Drive", folder: "Server backups", token: AUTHORIZE_OUTPUT }));
  return { ...loaded, ...cloud, destination };
}

test("a backup is sealed with the passphrase and opens only with it", async () => {
  const { server } = loadServer();
  const data = Buffer.from("the dashboard's data ăîș");
  const sealed = await server.encrypt(data, "correct horse battery");
  assert.ok(!sealed.includes(data), "nothing is readable");
  assert.equal((await server.decrypt(sealed, "correct horse battery")).toString(), data.toString());
  await assert.rejects(server.decrypt(sealed, "wrong horse battery"), /Wrong passphrase/);
  const damaged = Buffer.from(sealed); damaged[damaged.length - 20] ^= 1;
  await assert.rejects(server.decrypt(damaged, "correct horse battery"), /damaged/);
  await assert.rejects(server.decrypt(Buffer.from("not a backup at all, just text"), "x"), /not a backup/);
});

test("the settings keep the passphrase on the server and never send it", async () => {
  const { server, readJson } = loadServer();
  assert.throws(() => server.saveBackupSettings({ enabled: "true", frequency: "daily", hour: "3", weekday: "0", keep: "14" }), /passphrase first/);
  assert.throws(() => server.saveBackupSettings({ hour: "3", weekday: "0", keep: "14", passphrase: "short" }), /at least 12/);
  assert.throws(() => server.saveBackupSettings({ hour: "24", weekday: "0", keep: "14" }), /valid time/);
  assert.throws(() => server.saveBackupSettings({ hour: "3", weekday: "0", keep: "0" }), /between 1 and 365/);
  server.saveBackupSettings({ enabled: "true", frequency: "weekly", hour: "4", weekday: "0", keep: "10", timeZone: "Europe/Bucharest", passphrase: "correct horse battery" });
  const state = plain(server.cloudState());
  assert.equal(state.passphraseSet, true);
  assert.ok(!JSON.stringify(state).includes("correct horse"), "the passphrase stays on the server");
  assert.deepEqual(state.schedule, { enabled: true, frequency: "weekly", hour: 4, weekday: 0, timeZone: "Europe/Bucharest", keep: 10 });
  // Saving without a passphrase keeps the one there is.
  server.saveBackupSettings({ enabled: "true", frequency: "daily", hour: "3", weekday: "0", keep: "10", timeZone: "Europe/Bucharest" });
  assert.equal(readJson("cloud").passphrase, "correct horse battery");
});

test("Google Drive is added from what rclone authorize printed, limited to its own files", async () => {
  const { destination, calls, data } = await withDrive();
  assert.equal(destination.type, "drive");
  assert.equal(destination.folder, "Server backups");
  const config = readFileSync(path.join(data, "cloud-rclone.conf"), "utf8");
  assert.match(config, new RegExp(`^\\[${destination.id}\\]\\ntype = drive\\nscope = drive\\.file\\ntoken = \\{"access_token"`, "m"));
  assert.deepEqual(calls.map((call) => call.command), ["mkdir", "lsjson"], "the connection is tried before it is saved");
  assert.equal(calls[0].target, `${destination.id}:Server backups`);
  assert.ok(calls[0].argv.includes("--config"));
});

test("a destination that does not work is not saved", async () => {
  const cloud = fakeCloud();
  cloud.fail.add("mkdir");
  const { server, data } = loadServer({ host: cloud.host });
  await assert.rejects(server.saveDestination({ type: "drive", name: "Drive", token: TOKEN }), /Google Drive did not accept the connection: .*mkdir refused by the cloud/);
  assert.deepEqual(plain(server.cloudState().destinations), []);
  assert.doesNotMatch(readFileSync(path.join(data, "cloud-rclone.conf"), "utf8"), /lsc/);
  await assert.rejects(server.saveDestination({ type: "drive", name: "Drive", token: "not a token" }), /Paste what rclone authorize printed/);
  await assert.rejects(server.saveDestination({ type: "drive", name: "Drive", folder: "../up", token: TOKEN }), /folder name/);
});

test("OneDrive asks Microsoft which drive belongs to the account", async () => {
  const cloud = fakeCloud();
  const asked = [];
  const fetch = async (url, options) => {
    asked.push({ url, authorization: options.headers.Authorization });
    return { ok: true, status: 200, json: async () => ({ id: "b!drive", driveType: "personal", owner: { user: { displayName: "Florin" } } }) };
  };
  const { server, data } = loadServer({ host: cloud.host, fetch });
  const destination = plain(await server.saveDestination({ type: "onedrive", name: "OneDrive", token: AUTHORIZE_OUTPUT }));
  assert.deepEqual(asked, [{ url: "https://graph.microsoft.com/v1.0/me/drive", authorization: "Bearer ya29.access" }]);
  assert.equal(destination.account, "Florin");
  assert.match(readFileSync(path.join(data, "cloud-rclone.conf"), "utf8"), /drive_id = b!drive\ndrive_type = personal/);
  const expired = loadServer({ host: fakeCloud().host, fetch: async () => ({ ok: false, status: 401 }) }).server;
  await assert.rejects(expired.saveDestination({ type: "onedrive", name: "OneDrive", token: TOKEN }), /expired/);
});

test("Proton Drive's password is obscured through rclone's input, and the one-time code dropped", async () => {
  const cloud = fakeCloud();
  const { server, data } = loadServer({ host: cloud.host });
  await server.saveDestination({ type: "protondrive", name: "Proton", username: "me@proton.me", password: "proton secret", code: "123456" });
  const obscured = cloud.calls.filter((call) => call.command === "obscure");
  assert.deepEqual(obscured.map((call) => call.input), ["proton secret"], "on its input, never as an argument");
  const config = readFileSync(path.join(data, "cloud-rclone.conf"), "utf8");
  assert.match(config, /username = me@proton\.me\npassword = obscured\(proton secret\)/);
  assert.doesNotMatch(config, /2fa/, "the code was used for the first sign-in");
  await assert.rejects(server.saveDestination({ type: "protondrive", name: "Proton", username: "me@proton.me" }), /email and password/);
});

test("a backup holds the dashboard's data without sign-ins or cloud secrets, and old ones are deleted", async () => {
  const { server, destination, files, stored, data } = await withDrive();
  server.saveBackupSettings({ enabled: "false", frequency: "daily", hour: "3", weekday: "0", keep: "2", timeZone: "UTC" });
  writeFileSync(path.join(data, "sessions.json"), "{}");
  mkdirSync(path.join(data, "runs"));
  writeFileSync(path.join(data, "runs", "run-1.log"), "run output");
  for (let made = 0; made < 3; made++) {
    const [result] = plain(await server.backupNow());
    assert.equal(result.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const kept = files(destination);
  assert.equal(kept.length, 2, "only the latest 2 are kept");
  assert.ok(kept.every((name) => /^lsc-backup-.*\.lscb$/.test(name)));
  // What is inside, opened with the passphrase.
  const opened = gunzipSync(await server.decrypt(stored(destination, kept[1]), "correct horse battery"));
  const listing = spawnSync("tar", ["-tf", "-"], { input: opened }).stdout.toString();
  assert.match(listing, /scripts\.json/);
  assert.match(listing, /runs\/run-1\.log/);
  assert.match(listing, /config\.json/);
  assert.doesNotMatch(listing, /sessions\.json|cloud\.json|cloud-rclone\.conf/);
  const state = plain(server.cloudState()).destinations[0];
  assert.equal(state.last.ok, true);
  assert.equal(state.last.file, kept[1]);
});

test("a failed upload is recorded and announced, and one backup runs at a time", async () => {
  const { server, fail } = await withDrive();
  const events = [];
  server.onDashboardEvent((event) => events.push(event));
  fail.add("rcat");
  const [result] = plain(await server.backupNow());
  assert.equal(result.ok, false);
  assert.match(result.error, /rcat refused by the cloud/);
  assert.equal(events[0].type, "backup-failed");
  assert.equal(events[0].title, "Cloud backup failed: My Drive");
  assert.equal(plain(server.cloudState()).destinations[0].last.ok, false);
  fail.clear();
  const first = server.backupNow();
  assert.throws(() => server.backupNow(), /already running/);
  await first;
});

test("backups are listed newest first and deleted by name only", async () => {
  const { server, destination, files } = await withDrive();
  await server.backupNow();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await server.backupNow();
  const listed = plain(await server.listBackups(destination.id));
  assert.equal(listed.length, 2);
  assert.ok(listed[0].name > listed[1].name);
  assert.ok(listed[0].bytes > 0);
  await server.deleteBackup(destination.id, listed[1].name);
  assert.deepEqual(files(destination), [listed[0].name]);
  await assert.rejects(server.deleteBackup(destination.id, "../../etc/passwd"), /Backup not found/);
  await assert.rejects(server.listBackups("nope"), /destination not found/);
});

test("restoring brings the data back as it was, and keeps the browsers and cloud settings", async () => {
  const { server, destination, data, readJson } = await withDrive();
  server.save("devices", { [ "a".repeat(64) ]: { name: "Old laptop", created: "1" } });
  await server.backupNow();
  const [backup] = plain(await server.listBackups(destination.id));
  // Changes made after the backup.
  server.save("scripts", [{ id: "b", name: "Changed", path: "/srv/scripts/b.sh", cron: "" }]);
  server.save("alerts", [{ id: "x", name: "New", metric: "cpu", threshold: 90, cooldownMinutes: 30, enabled: true }]);
  server.save("devices", { ["b".repeat(64)]: { name: "This browser", created: "2" } });
  writeFileSync(path.join(data, "sessions.json"), JSON.stringify({ s: { device: "b".repeat(64) } }));
  await assert.rejects(server.restoreBackup(destination.id, backup.name, "wrong horse battery"), /Wrong passphrase/);
  assert.equal(readJson("scripts")[0].name, "Changed", "a failed restore changes nothing");
  await server.restoreBackup(destination.id, backup.name);
  assert.equal(readJson("scripts")[0].name, "Backup");
  assert.ok(!existsSync(path.join(data, "alerts.json")), "a record added since goes");
  assert.deepEqual(Object.keys(readJson("devices")).sort(), ["a".repeat(64), "b".repeat(64)], "the browser that restored stays authorized");
  assert.deepEqual(readJson("sessions"), { s: { device: "b".repeat(64) } });
  assert.equal(plain(server.cloudState()).destinations.length, 1, "the cloud settings stay");
  assert.ok(!readdirSync(data).some((name) => name.startsWith(".restore-")), "nothing is left behind");
});

test("the schedule makes a backup once per time it names, in its time zone", async () => {
  const { server, calls } = await withDrive();
  const uploads = () => calls.filter((call) => call.command === "rcat").length;
  // 03:00 in Bucharest is 01:00 UTC in November.
  const schedule = { enabled: true, frequency: "daily", hour: 3, weekday: 0, timeZone: "Europe/Bucharest", keep: 14 };
  assert.equal(new Date(server.lastSlot(schedule, Date.parse("2026-11-12T16:00:00Z"))).toISOString(), "2026-11-12T01:00:00.000Z");
  assert.equal(new Date(server.lastSlot(schedule, Date.parse("2026-11-12T00:30:00Z"))).toISOString(), "2026-11-11T01:00:00.000Z");
  // Summer time: 03:00 is 00:00 UTC.
  assert.equal(new Date(server.lastSlot(schedule, Date.parse("2026-07-01T12:00:00Z"))).toISOString(), "2026-07-01T00:00:00.000Z");
  // Weekly on Sunday (2026-11-08 was a Sunday).
  assert.equal(new Date(server.lastSlot({ ...schedule, frequency: "weekly", weekday: 0 }, Date.parse("2026-11-12T16:00:00Z"))).toISOString(), "2026-11-08T01:00:00.000Z");
  server.saveBackupSettings({ enabled: "true", frequency: "daily", hour: "3", weekday: "0", keep: "14", timeZone: "Europe/Bucharest" });
  const enabledAt = Date.now();
  assert.equal(await server.runDueBackup(enabledAt + 1000), false, "turning it on does not make up for a time already past");
  const tomorrow = server.lastSlot(schedule, enabledAt + 86400000) + 60000;
  assert.equal(await server.runDueBackup(tomorrow), true);
  assert.equal(uploads(), 1);
  assert.equal(await server.runDueBackup(tomorrow + 5 * 60000), false, "once per time");
});

// An rclone for real processes: `authorize` is the fake above, the rest keeps
// its remotes in a folder.
function realFakeRclone() {
  const bin = mkdtempSync(path.join(tmpdir(), "lsc-rclone-")), cloud = mkdtempSync(path.join(tmpdir(), "lsc-cloud-"));
  const authorize = new URL("./fixtures/fake-rclone-authorize.mjs", import.meta.url).pathname;
  writeFileSync(path.join(bin, "rclone"), [
    "#!/bin/sh",
    `[ "$1" = authorize ] && exec "${process.execPath}" "${authorize}" "$@"`,
    'while [ "$1" = --config ] || [ "$1" = --low-level-retries ]; do shift 2; done',
    'cmd=$1; shift; for last; do :; done',
    `where="${cloud}/\${last%%:*}/\${last#*:}"`,
    'case "$cmd" in mkdir) mkdir -p "$where" ;; lsjson) printf "[]" ;; *) exit 1 ;; esac',
    "",
  ].join("\n"), { mode: 0o755 });
  return bin;
}
async function signingIn(test) {
  const PATH = process.env.PATH;
  process.env.PATH = `${realFakeRclone()}${path.delimiter}${PATH}`;
  const loaded = loadServer({ realProcesses: true, env: { PATH: process.env.PATH } });
  try {
    return await test(loaded);
  } finally {
    loaded.server.stopSignIn();
    process.env.PATH = PATH;
  }
}
const returned = (page, values) => {
  const state = new URL(page).searchParams.get("state");
  return `http://127.0.0.1:53682/?${new URLSearchParams({ state, ...values })}`;
};

test("Google Drive is connected from the page: sign in, then paste the address the browser came back to", () => signingIn(async ({ server, data }) => {
  await assert.rejects(server.finishSignIn({ type: "drive", address: "http://127.0.0.1:53682/?state=x&code=good" }), /Sign in again/);
  const page = await server.startSignIn("drive");
  assert.match(page, /^https:\/\/accounts\.example\/drive\/auth\?/, "the service's own sign-in page");
  const destination = plain(await server.finishSignIn({ type: "drive", name: "My Drive", folder: "Backups", address: returned(page, { code: "good", scope: "https://www.googleapis.com/auth/drive.file" }) }));
  assert.equal(destination.name, "My Drive");
  assert.match(readFileSync(path.join(data, "cloud-rclone.conf"), "utf8"), /scope = drive\.file\ntoken = \{"access_token":"drive-access"/);
  await assert.rejects(server.finishSignIn({ type: "drive", address: returned(page, { code: "good" }) }), /Sign in again/, "a sign-in is used once");
}));

test("a wrong address leaves the sign-in waiting, and a refused or bad code says why", () => signingIn(async ({ server }) => {
  const page = await server.startSignIn("drive");
  await assert.rejects(server.finishSignIn({ type: "drive", address: "https://example.com/something" }), /whole address/);
  await assert.rejects(server.finishSignIn({ type: "drive", address: "http://127.0.0.1:53682/?state=older&code=good" }), /older sign-in/);
  // rclone is still waiting: the right address works.
  await assert.rejects(server.finishSignIn({ type: "drive", name: "Drive", address: returned(page, { code: "bad" }) }), /Google Drive did not give access: failed to get token: oauth2: "invalid_grant"/);
  const again = await server.startSignIn("drive");
  await assert.rejects(server.finishSignIn({ type: "drive", address: returned(again, { error: "access_denied" }) }), /Access was not allowed \(access_denied\)/);
  // A new sign-in replaces one still waiting, whose port it needs.
  await server.startSignIn("onedrive");
  await server.startSignIn("onedrive");
  await assert.rejects(server.startSignIn("protondrive"), /Choose a cloud service/);
}));

test("a OneDrive backup goes in one request, and empty backups left by failed uploads are deleted", async () => {
  const cloud = fakeCloud();
  const puts = [];
  let refuse = false;
  const fetch = async (url, options = {}) => {
    if (url.endsWith("/me/drive")) return { ok: true, status: 200, json: async () => ({ id: "1FA1EA044EF32604", driveType: "personal", owner: { user: { email: "me@example.com" } } }) };
    puts.push({ url, method: options.method, authorization: options.headers.Authorization, bytes: options.body.length });
    if (refuse) return { ok: false, status: 401, json: async () => ({ error: { code: "unauthenticated", message: "Unauthenticated" } }) };
    // Kept where the fake rclone lists the folder from.
    const name = decodeURIComponent(/\/([^/]+):\/content$/.exec(url)[1]);
    writeFileSync(path.join(cloud.cloud, destination.id, "My Backups", name), Buffer.from(options.body));
    return { ok: true, status: 201, json: async () => ({}) };
  };
  const { server, data } = loadServer({ host: cloud.host, fetch });
  writeFileSync(path.join(data, "config.json"), JSON.stringify({ username: "admin", salt: "00", password: "hash" }));
  server.saveBackupSettings({ hour: "3", weekday: "0", keep: "14", timeZone: "UTC", passphrase: "correct horse battery" });
  const destination = plain(await server.saveDestination({ type: "onedrive", name: "OneDrive", folder: "My Backups", token: TOKEN }));
  // What two failed uploads left behind.
  for (const name of ["lsc-backup-2026-11-12T18-13-10-110Z.lscb", "lsc-backup-2026-11-12T18-14-45-714Z.lscb"]) writeFileSync(path.join(cloud.cloud, destination.id, "My Backups", name), "");
  const [result] = plain(await server.backupNow());
  assert.equal(result.ok, true);
  assert.equal(puts.length, 1);
  assert.match(puts[0].url, /^https:\/\/graph\.microsoft\.com\/v1\.0\/drives\/1FA1EA044EF32604\/root:\/My%20Backups\/lsc-backup-[\w-]+\.lscb:\/content$/);
  assert.equal(puts[0].method, "PUT");
  assert.equal(puts[0].authorization, "Bearer ya29.access", "the token rclone keeps");
  assert.ok(!cloud.calls.some((call) => call.command === "rcat"), "not through rclone's upload session");
  assert.deepEqual(cloud.files(destination), [result.file], "the empty backups are gone");
  assert.equal(plain(await server.listBackups(destination.id)).length, 1);
  refuse = true;
  const [failed] = plain(await server.backupNow());
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "OneDrive: HTTP 401 (Unauthenticated)");
});

test("the token is read from rclone authorize's output in both of its forms", () => {
  const { server } = loadServer();
  // Given only the service, rclone prints the token itself.
  assert.equal(server.tokenFrom(AUTHORIZE_OUTPUT).refresh_token, "1//refresh");
  assert.equal(server.tokenFrom(TOKEN).access_token, "ya29.access");
  // Given settings as well, as for Google Drive's scope, it prints settings
  // back as unpadded URL-safe base64 of {"token":"{…}"}.
  const settings = Buffer.from(JSON.stringify({ token: TOKEN })).toString("base64url");
  assert.ok(!settings.includes("{") && !settings.endsWith("="));
  assert.equal(server.tokenFrom(`2026/11/12 NOTICE: Got code\nPaste the following into your remote machine --->\n${settings}\n<---End paste\n`).refresh_token, "1//refresh");
  assert.equal(server.tokenFrom(settings).access_token, "ya29.access", "that part alone");
  assert.throws(() => server.tokenFrom(Buffer.from('{"scope":"drive.file"}').toString("base64url")), /Paste what rclone authorize printed/);
});
