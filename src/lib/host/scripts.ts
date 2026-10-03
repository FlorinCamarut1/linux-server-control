// Registered scripts: folders, run options, running and stopping them, and
// their run logs.
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { constants } from "node:os";
import path from "node:path";
import { DATA, audit, emitDashboardEvent, read, save } from "./store";
import { ROOT_SCRIPT_HELPER, run, runInput, serverSettings, ssh } from "./ssh";
import { RECORD_ID, type RunOption, type Script, type ScriptRun, folders, schedules, scriptRuns, scripts } from "./records";
import { rootScriptStatus, syncCron } from "./cron";
import { isAllowedPath, resolveAllowedDirectory, resolveSelectedFile } from "./files";
const MAX_SCRIPT_RUNS = 2000;
// Keeps the newest runs and deletes the logs of the records that are dropped.
function saveScriptRuns(runs: ScriptRun[]) {
  save("script-runs", runs.slice(0, MAX_SCRIPT_RUNS));
  const logs = path.join(DATA, "runs") + path.sep;
  for (const run of runs.slice(MAX_SCRIPT_RUNS))
    if (run.logPath?.startsWith(logs)) rmSync(/* turbopackIgnore: true */ run.logPath, { force: true });
}
// A server restart ends the SSH processes that were streaming running scripts,
// so their records would otherwise stay "running" forever.
export function recoverInterruptedRuns() {
  const runs = scriptRuns();
  if (!runs.some((item) => item.status === "running")) return;
  const now = new Date().toISOString();
  save("script-runs", runs.map((item) => {
    if (item.status !== "running") return item;
    try { appendFileSync(/* turbopackIgnore: true */ item.logPath, "\nThe run was interrupted because the dashboard restarted.\n"); } catch {}
    return { ...item, status: "failed" as const, completedAt: now, durationMs: Date.parse(now) - Date.parse(item.startedAt) };
  }));
}
export function parseRunOptions(value: unknown): RunOption[] {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value || "[]") : value ?? [];
    if (!Array.isArray(parsed) || parsed.length > 12) throw Error();
    return parsed.map((item) => {
      const label = String(item?.label || "").trim().slice(0, 80);
      const value = String(item?.value || "").trim().slice(0, 500);
      const description = String(item?.description || "").trim().slice(0, 180);
      if (!label || !value || /[\r\n\0]/.test(label + value + description)) throw Error();
      return { label, value, description, needsFile: item.needsFile === true };
    });
  } catch {
    throw Error("Each run option needs a name and an argument value");
  }
}
// A script's time limit in whole minutes, at most a week; empty or 0 for none.
export function parseTimeLimit(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text || text === "0") return undefined;
  const minutes = Number(text);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080)
    throw Error("The time limit must be a whole number of minutes, at most 10,080 (one week)");
  return minutes;
}
export function addFolder(input: string) {
  const name = input.trim().replace(/\s+/g, " ").slice(0, 60);
  if (!name) throw Error("Enter a folder name");
  if (name === "Unfiled") throw Error("This folder name is reserved");
  if (/[\r\n]/.test(name)) throw Error("The folder name must be one line");
  const all = folders();
  if (!all.includes(name)) save("folders", [...all, name]);
}
export async function deleteDashboardFolder(input: string, deleteScripts = false) {
  const name = input.trim();
  if (!name) throw Error("Choose a dashboard folder");
  const stored = read<string[]>("folders", []);
  const belongsToFolder = (script: Script) =>
    name === "Unfiled" ? !script.folder : script.folder === name;
  if (!stored.includes(name) && !scripts().some(belongsToFolder))
    throw Error("Folder not found");
  const removedScripts = scripts().filter(belongsToFolder);
  if (removedScripts.length && !deleteScripts)
    throw Error("This folder still contains scripts");
  const removedIds = new Set(removedScripts.map((script) => script.id));
  save("folders", stored.filter((folder) => folder !== name));
  if (removedIds.size) {
    save("scripts", scripts().filter((script) => !removedIds.has(script.id)));
    const removedSchedules = schedules().filter((item) => removedIds.has(item.scriptId));
    const remainingSchedules = schedules().filter((item) => !removedIds.has(item.scriptId));
    save("schedules", remainingSchedules);
    await syncCron(removedSchedules.map((item) => item.runAs || "user"));
  }
  audit(`folder deleted ${name} (${removedScripts.length} scripts)`);
  return { deletedScripts: removedScripts.length };
}
export function parseArguments(value: string) {
  if (value.length > 2000 || /[\r\n]/.test(value))
    throw Error("Arguments must be a single line shorter than 2,000 characters");
  const args: string[] = [];
  let current = "", quote = "", escaped = false;
  for (const char of value) {
    if (escaped) { current += char; escaped = false; }
    else if (char === "\\") escaped = true;
    else if (quote) {
      if (char === quote) quote = "";
      else current += char;
    } else if (char === "'" || char === '"') quote = char;
    else if (/\s/.test(char)) {
      if (current) { args.push(current); current = ""; }
    } else current += char;
  }
  if (escaped || quote) throw Error("Arguments contain an unfinished quote or escape");
  if (current) args.push(current);
  if (args.length > 30 || args.some((arg) => arg.length > 500))
    throw Error("Too many or overly long arguments");
  return args;
}
const MAX_RUN_LOG_BYTES = 10 * 1024 * 1024;
// The end of a run log, for the log viewer. Only the end is read from disk: a
// live view asks every two seconds, and a log may be 10 MB. A view that starts
// inside the log starts at a line.
const RUN_LOG_VIEW_BYTES = 64 * 1024;
export function readRunLogEnd(logPath: string): string | null {
  let file: number;
  try { file = openSync(/* turbopackIgnore: true */ logPath, "r"); } catch { return null; }
  try {
    const size = fstatSync(file).size, start = Math.max(0, size - RUN_LOG_VIEW_BYTES);
    const buffer = Buffer.alloc(size - start);
    const read = readSync(file, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8", 0, read);
    return start > 0 && text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(file);
  }
}
// The runs in progress: the local process that streams each one's output, and
// what stopping it takes. Kept on globalThis, like the event bus, so that every
// instance of this module sees the same runs.
type ActiveRun = {
  child: ChildProcess;
  // The run's process group on the server, as RUN_WRAPPER reported it.
  group?: number;
  // A root run is stopped by the root script helper, which older helpers cannot.
  root: boolean;
  helperStop: boolean;
  // Set once the run is being stopped: by an account, or by the time limit.
  stop?: { by?: string; timedOut?: boolean };
  timers: ReturnType<typeof setTimeout>[];
};
const activeRuns = ((globalThis as { lscActiveRuns?: Map<string, ActiveRun> }).lscActiveRuns ??= new Map<string, ActiveRun>());
// Every run's command starts in this shell, which first reports the process
// group it runs in: over SSH the session sshd created for the command, locally
// a group of its own. Signalling that group reaches the script and everything
// it started. Without /proc nothing is reported, and the run still starts.
const RUN_WRAPPER = 'read -r _ _ _ _ group _ < /proc/$$/stat && printf "LSC_RUN_GROUP %s\\n" "$group"; exec "$@"';
const RUN_GROUP_LINE = /(^|\n)LSC_RUN_GROUP (\d+)\n/;
// Signals a run's process group; a group that has ended already is no error.
// Group 1 is refused: kill -1 would reach every process of the SSH user.
const SIGNAL_GROUP = 'case "$2" in ""|*[!0-9]*|0|1) exit 64 ;; esac; kill -s "$1" -- "-$2" 2>/dev/null; exit 0';
// How long a stopped run has to end after TERM before it is killed.
const STOP_GRACE_MS = 10000;
// Work for later in a run's life, dropped when the run ends. The timers never
// keep the process alive on their own.
function later(active: ActiveRun, ms: number, work: () => void) {
  const timer = setTimeout(work, ms);
  timer.unref?.();
  active.timers.push(timer);
}
export async function runScript(s: Script, rawArguments = "", selectedFile = "") {
  const scriptArguments = parseArguments(rawArguments);
  if (selectedFile) {
    const fileIndex = scriptArguments.indexOf("--file");
    scriptArguments.splice(
      fileIndex >= 0 ? fileIndex + 1 : scriptArguments.length,
      0,
      await resolveSelectedFile(selectedFile),
    );
  }
  const root = s.runAs === "root";
  const helper = root ? await rootScriptStatus() : { available: false, stop: false };
  if (root && !helper.available)
    throw Error("Root script access has not been enabled on this server");
  const runId = randomUUID(),
    // A helper that can stop runs records this one under its ID.
    command = root
      ? ["sudo", "-n", ROOT_SCRIPT_HELPER, "run", ...(helper.stop ? ["--id", runId] : []), s.path, ...scriptArguments]
      : ["/bin/bash", s.path, ...scriptArguments],
    log = path.join(DATA, "runs", runId + ".log"),
    local = !serverSettings().sshTarget,
    [cmd, args] = ssh(["sh", "-c", RUN_WRAPPER, "sh", ...command]);
  mkdirSync(path.dirname(log), { recursive: true });
  const started = Date.now();
  const record: ScriptRun = {
    id: runId, scriptId: s.id, scriptName: s.name, startedAt: new Date(started).toISOString(),
    arguments: rawArguments, status: "running", logPath: log,
  };
  saveScriptRuns([record, ...scriptRuns()]);
  const out = openSync(log, "a");
  let finished = false, written = 0;
  // Output past the limit is read and dropped, so a noisy script keeps running
  // without filling the data volume.
  const write = (chunk: Buffer | string) => {
    if (finished || written > MAX_RUN_LOG_BYTES) return;
    const data = Buffer.from(chunk);
    writeSync(out, data.subarray(0, MAX_RUN_LOG_BYTES - written));
    written += data.length;
    if (written > MAX_RUN_LOG_BYTES) writeSync(out, "\n[Output truncated: this log reached 10 MB.]\n");
  };
  // What the dashboard adds to the log is written past the limit as well.
  const note = (text: string) => { if (!finished) writeSync(out, text); };
  let active: ActiveRun | undefined;
  // The output stream starts with the wrapper's line naming the process group,
  // possibly after what a login profile printed; that line stays out of the log.
  let head: Buffer | null = Buffer.alloc(0);
  const output = (chunk: Buffer) => {
    if (!head) return write(chunk);
    head = Buffer.concat([head, chunk]);
    const found = RUN_GROUP_LINE.exec(head.toString("latin1"));
    if (!found && head.length < 4096) return;
    if (found && active && Number(found[2]) > 1) active.group = Number(found[2]);
    write(found ? Buffer.concat([head.subarray(0, found.index + found[1].length), head.subarray(found.index + found[0].length)]) : head);
    head = null;
  };
  const finish = (code: number | null, signal: NodeJS.Signals | null = null) => {
    if (finished) return;
    if (head) write(head);
    head = null;
    activeRuns.delete(runId);
    for (const timer of active?.timers ?? []) clearTimeout(timer);
    const stop = active?.stop;
    if (stop) note(stop.timedOut
      ? `\n[Stopped: the run took longer than its time limit of ${s.timeLimitMinutes} minutes.]\n`
      : `\n[Stopped by ${stop.by}.]\n`);
    finished = true;
    closeSync(out);
    const completed = Date.now();
    // A run ended by a signal reports it the way a shell would, as 128 + its number.
    const exitCode = code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1);
    const status = stop ? (stop.timedOut ? "failed" as const : "stopped" as const) : code === 0 ? "success" as const : "failed" as const;
    const all = scriptRuns().map((item) => item.id === runId ? {
      ...item, completedAt: new Date(completed).toISOString(), durationMs: completed - started, exitCode, status,
      ...(stop?.by ? { stoppedBy: stop.by } : {}), ...(stop?.timedOut ? { timedOut: true } : {}),
    } : item);
    save("script-runs", all);
    audit(`script ${s.name} ${status === "success" ? "completed" : status} (${runId})`);
    if (status === "failed") emitDashboardEvent({
      type: "script-failed", severity: "critical", title: `Script failed: ${s.name}`,
      message: stop?.timedOut ? `The run was stopped after its time limit of ${s.timeLimitMinutes} minutes.`
        : code === null && !signal ? "The run could not be started."
        : `The run ended with exit code ${exitCode} after ${Math.round((completed - started) / 1000)} s.`,
    });
  };
  try {
    // Locally the run gets a process group of its own, which stopping it signals.
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: local });
    active = { child, root, helperStop: helper.stop, timers: [] };
    activeRuns.set(runId, active);
    child.stdout?.on("data", output);
    child.stderr?.on("data", write);
    child.on("error", (error) => {
      note(`\nThe run could not be started: ${error.message}\n`);
      finish(null);
    });
    child.on("close", finish);
    if (s.timeLimitMinutes) later(active, s.timeLimitMinutes * 60000, () => {
      stopActiveRun(runId, { timedOut: true }).catch((error) =>
        note(`\n[The time limit was reached, but the run could not be stopped: ${error instanceof Error ? error.message : error}]\n`));
    });
  } catch (error) {
    finish(null);
    throw error;
  }
  audit("run script " + s.name + " (" + runId + ")");
  return record;
}
// Stops a run in progress: its process group on the server is sent TERM, and
// KILL if it has not ended after a grace period. The run is recorded once its
// command has ended, as stopped by this account.
export async function stopRun(runId: string, account: string) {
  const record = scriptRuns().find((item) => item.id === runId);
  if (!record) throw Error("Run not found");
  if (record.status !== "running" || !activeRuns.has(runId)) throw Error("This run has already ended");
  await stopActiveRun(runId, { by: account });
  audit(`stopping script ${record.scriptName} (${runId})`);
}
async function stopActiveRun(runId: string, reason: NonNullable<ActiveRun["stop"]>) {
  const active = activeRuns.get(runId);
  if (!active) return;
  if (active.root && !active.helperStop)
    throw Error("This root script cannot be stopped: the root script helper on the server is an older version. Run scripts/install-root-script-access.sh again to update it.");
  const signal = async (name: "TERM" | "KILL") => {
    if (active.root) await run(["sudo", "-n", ROOT_SCRIPT_HELPER, "stop", runId, name]);
    else if (active.group) await run(["sh", "-c", SIGNAL_GROUP, "sh", name, String(active.group)]);
    // The group is not known yet: ending the local process is all that can be done.
    else active.child.kill(`SIG${name}`);
  };
  // Set before signalling: the run may end before the signal command returns.
  const first = !active.stop;
  active.stop ??= reason;
  try {
    await signal("TERM");
  } catch (error) {
    if (first && activeRuns.get(runId) === active) active.stop = undefined;
    throw error;
  }
  // A script that ignores TERM is killed. Should even that not end it (the
  // server stopped answering), the local process streaming it is ended.
  later(active, STOP_GRACE_MS, () => {
    void signal("KILL").catch(() => {}).finally(() => {
      if (activeRuns.get(runId) === active) later(active, STOP_GRACE_MS, () => active.child.kill("SIGKILL"));
    });
  });
}
export async function addScript(input: Record<string, string>) {
  const name = (input.name || "").trim().slice(0, 80),
    requested = input.path || "",
    folder = (input.folder || "").trim().replace(/\s+/g, " ").slice(0, 60),
    expr = "",
    runAs: "user" | "root" = input.runAs === "root" ? "root" : "user";
  if (!name) throw Error("Enter a name");
  if (/[\r\n]/.test(folder)) throw Error("The folder name must be one line");
  const runOptions = parseRunOptions(input.runOptions);
  const timeLimitMinutes = parseTimeLimit(input.timeLimitMinutes);
  if (folder && !folders().includes(folder)) throw Error("Choose an existing folder");
  if (runAs === "root") {
    const helper = await rootScriptStatus();
    if (!helper.available) throw Error("Root script access has not been enabled on this server");
    // Reaching the limit stops the run, which root runs need the current helper for.
    if (timeLimitMinutes && !helper.stop)
      throw Error("A time limit on a root script needs the current root script helper: run scripts/install-root-script-access.sh on the server again");
  }
  let resolved: string;
  try { resolved = (await run(["realpath", "-e", "--", requested])).trim(); }
  catch { throw Error("The script file was not found"); }
  if (
    !isAllowedPath(resolved) ||
    !resolved.endsWith(".sh")
  )
    throw Error(
      "The script must be an existing .sh file inside an allowed location",
    );
  try { await run(["test", "-f", resolved]); }
  catch { throw Error("The script must be a regular file"); }
  const id = RECORD_ID.test(input.id || "") ? input.id : randomUUID();
  const all = scripts().filter((x) => x.id !== id);
  all.push({ id, name, path: resolved, cron: expr, folder, runAs, runOptions, ...(timeLimitMinutes ? { timeLimitMinutes } : {}) });
  save("scripts", all);
}
export async function createCustomScript(input: Record<string, string>) {
  const directory = await resolveAllowedDirectory(input.directory || "");
  const filename = (input.filename || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.sh$/.test(filename))
    throw Error("Use a shell-script filename ending in .sh");
  const target = path.posix.join(directory, filename);
  if (!isAllowedPath(target)) throw Error("Choose an allowed script folder");
  try {
    await run(["test", "!", "-e", target]);
  } catch {
    throw Error("A file or folder with this name already exists");
  }
  const content = input.content || "";
  if (!content.trim() || content.includes("\0") || Buffer.byteLength(content, "utf8") > 128 * 1024)
    throw Error("Enter a shell script up to 128 KB");
  const program = content.startsWith("#!")
    ? content
    : "#!/usr/bin/env bash\nset -eu\n\n" + content;
  await runInput(
    ["sh", "-c", 'umask 077; cat > "$1"; chmod 700 "$1"', "sh", target],
    program,
    15000,
  );
  try {
    await addScript({ ...input, path: target });
  } catch (error) {
    await run(["rm", "-f", "--", target]).catch(() => {});
    throw error;
  }
  audit("created custom script " + target);
}
