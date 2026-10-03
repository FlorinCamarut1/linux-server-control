// Schedules: validation, the managed crontab lines, the root helpers and the
// schedule log.
import { randomBytes } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DATA, audit, emitDashboardEvent, save } from "./store";
import { CommandError, ROOT_CRON_HELPER, ROOT_SCRIPT_HELPER, run, runInput, serverSettings, shell } from "./ssh";
import { type CronRun, RECORD_ID, type Schedule, type Script, cronRuns, oneLine, parseArguments, schedules, scripts } from "./records";
// Shared by the schedule form and configuration restore, so both enforce the
// same rules, in particular that root schedules may only run approved scripts.
export function normalizeSchedule(input: Record<string, unknown>, knownScripts: Script[], rootCronAvailable: boolean): Schedule {
  const id = typeof input.id === "string" && RECORD_ID.test(input.id) ? input.id : randomBytes(16).toString("hex");
  const script = knownScripts.find((item) => item.id === input.scriptId);
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!script && !command) throw Error("Select an existing script");
  if (command.length > 2000 || /[\r\n\0]/.test(command))
    throw Error("The command must be one line shorter than 2,000 characters");
  const expression = typeof input.expression === "string" ? input.expression.trim() : "";
  validCron(expression);
  const runAs = input.runAs === "root" ? "root" : "user";
  if (runAs === "root" && command)
    throw Error("Root schedules must use an approved script; custom root commands are disabled");
  if (runAs === "root" && !rootCronAvailable)
    throw Error("Root schedules have not been enabled on this server: they need both the root cron helper and the root script helper");
  // A script's arguments for this schedule, such as one of its run options; a
  // custom command carries its own.
  const args = script && typeof input.arguments === "string" ? input.arguments.trim() : "";
  parseArguments(args);
  return {
    id,
    scriptId: script?.id || "",
    expression,
    label: oneLine(input.label, 80) || "Schedule",
    enabled: input.enabled !== false && input.enabled !== "false",
    runAs,
    ...(command ? { command } : {}),
    ...(args ? { arguments: args } : {}),
  };
}
// What a schedule runs. The conditions set on its script hold here as well: its
// arguments, its variables (for the SSH user) and its time limit, which
// timeout(1) enforces with TERM and, 10 seconds later, KILL.
export function scheduleCommand(schedule: Schedule, script: Script | undefined, user: CronUser) {
  if (schedule.command) return schedule.command;
  if (!script) return "";
  const args = parseArguments(schedule.arguments || "");
  const limit = script.timeLimitMinutes ? `timeout -k 10s ${script.timeLimitMinutes}m ` : "";
  // Root's crontab calls the same helper as an immediate root run, so the
  // approved root-script directories also apply to scheduled runs.
  if (user === "root") return `${limit}${ROOT_SCRIPT_HELPER} run ${shell([script.path, ...args])}`;
  const variables = Object.entries(script.variables ?? {}).map(([name, value]) => `${name}=${value}`);
  return `${limit}${variables.length ? `env ${shell(variables)} ` : ""}/bin/bash ${shell([script.path, ...args])}`;
}
export async function saveSchedule(input: Record<string, unknown>) {
  const item = normalizeSchedule(input, scripts(), input.runAs === "root" && await rootSchedulesAvailable());
  const previous = schedules().find((schedule) => schedule.id === item.id);
  save("schedules", [...schedules().filter((schedule) => schedule.id !== item.id), item]);
  await syncCron([previous?.runAs || "user"]);
  audit("schedule saved " + item.id);
}
export type CronUser = "user" | "root";
// The root helpers' availability and root's crontabs rarely change, so they are
// read at most every few minutes, and again right after the dashboard changes them.
type RootStatus = { target: string; at: number; root: { available: boolean; cron: string; system: string }; rootScript: { available: boolean; stop: boolean } };
const ROOT_STATUS_TTL_MS = 5 * 60 * 1000;
let rootStatus: RootStatus | undefined;
function cachedRootStatus() {
  const target = serverSettings().sshTarget;
  return rootStatus && rootStatus.target === target && Date.now() - rootStatus.at < ROOT_STATUS_TTL_MS ? rootStatus : undefined;
}
export function invalidateRootStatus() {
  rootStatus = undefined;
}
export async function rootHelperStatus() {
  const cached = cachedRootStatus();
  if (cached) return cached;
  const [root, rootScript] = await Promise.all([rootCronStatus(), rootScriptStatus()]);
  return (rootStatus = { target: serverSettings().sshTarget, at: Date.now(), root, rootScript });
}
// Reads a crontab. Only a missing crontab counts as empty: any other failure
// must abort, or the following install would erase the user's own entries.
export async function cron(user: CronUser = "user") {
  if (user === "root") return run(["sudo", "-n", ROOT_CRON_HELPER, "list"]);
  try {
    return await run(["crontab", "-l"]);
  } catch (error) {
    // cronie and Debian cron print "no crontab for USER"; BusyBox prints
    // "crontab: can't open 'USER': No such file or directory".
    if (error instanceof CommandError && /no crontab for|can't open .*no such file/i.test(error.message)) return "";
    throw error;
  }
}
export async function rootCronStatus() {
  try {
    const [cron, system] = await Promise.all([
      run(["sudo", "-n", ROOT_CRON_HELPER, "list"]),
      run(["sudo", "-n", ROOT_CRON_HELPER, "system-list"]),
    ]);
    return { available: true, cron, system };
  } catch {
    return { available: false, cron: "", system: "" };
  }
}
// Root schedules are installed with the cron helper and run through the script
// helper, so they need both.
export async function rootSchedulesAvailable() {
  const [cron, script] = await Promise.all([rootCronStatus(), rootScriptStatus()]);
  return cron.available && script.available;
}
// A helper that can stop the runs it starts says so in its status; older
// helpers print nothing, and their root runs cannot be stopped.
export async function rootScriptStatus() {
  try {
    const output = await run(["sudo", "-n", ROOT_SCRIPT_HELPER, "status"]);
    return { available: true, stop: /^stop$/m.test(output) };
  } catch {
    return { available: false, stop: false };
  }
}
export function validCron(x: string) {
  if (!x) throw Error("Choose when the schedule should run");
  if (x === "@reboot") return;
  const f = x.split(/\s+/);
  if (
    f.length !== 5 ||
    f.some(
      (v) => !/^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/.test(v),
    )
  )
    throw Error("Invalid cron expression");
}
const CRON_MARKER = "# media-dashboard:";
// Each account's schedules log to their own file: a log that root created
// could not be written by the SSH user's schedules, nor trimmed by the dashboard.
export function scheduleLog(user: CronUser) {
  return path.posix.join(serverSettings().remoteLogs, user === "root" ? "schedules-root.log" : "schedules.log");
}
const MAX_CRON_BACKUPS = 20;
// Builds one managed crontab line. Cron turns every unescaped "%" in the command
// into a newline, so all of them are escaped, including those in custom commands.
// The job must run even when its log cannot be written: the default log folder
// is under /tmp, which is empty again after a restart of the server. So the SSH
// user's line creates the folder first, and the output is only sent to the log
// once the log has been opened. Root's line leaves the folder to the SSH user
// (a folder owned by root would lock that user's schedules out of it); the
// dashboard creates it again each time it reads the logs.
export function cronLine(schedule: Schedule, command: string, logFile: string, createFolder = true) {
  if (!/^[\w-]{1,64}$/.test(schedule.id)) throw Error("Invalid schedule identifier");
  validCron(schedule.expression);
  if (/[\r\n]/.test(command)) throw Error("The command must be one line");
  // The markers make scheduled work observable without granting cron any additional privileges.
  const log = shell([logFile]);
  const folder = createFolder ? `mkdir -p ${shell([path.posix.dirname(logFile)])} 2>/dev/null; ` : "";
  const body = `( ${folder}true 2>/dev/null >> ${log} && exec >> ${log} 2>&1; printf 'MEDIA_DASHBOARD_START ${schedule.id} %s\\n' "$(date -Is)"; ${command} ; code=$?; printf 'MEDIA_DASHBOARD_END ${schedule.id} %s %s\\n' "$(date -Is)" "$code"; exit "$code" )`;
  return `${schedule.expression} ${body.replaceAll("%", "\\%")} ${CRON_MARKER}${schedule.id}`;
}
function pruneCronBackups(user: CronUser) {
  const prefix = `cron-backup-${user}-`;
  const backups = readdirSync(/* turbopackIgnore: true */ DATA).filter((name) => name.startsWith(prefix) && name.endsWith(".json")).sort();
  for (const name of backups.slice(0, -MAX_CRON_BACKUPS)) rmSync(path.join(/* turbopackIgnore: true */ DATA, name), { force: true });
}
// Crontab updates are read-modify-write operations on the host, so they run one at
// a time and always install the latest saved schedules rather than a caller's copy.
let cronQueue: Promise<unknown> = Promise.resolve();
export function syncCron(extraUsers: CronUser[] = []) {
  const next = cronQueue.then(() => installSchedules(extraUsers));
  cronQueue = next.catch(() => {});
  return next;
}
async function installSchedules(extraUsers: CronUser[]) {
  const items = schedules();
  await run(["mkdir", "-p", serverSettings().remoteLogs]);
  const available = scripts();
  const users = new Set<CronUser>([
    ...items.map((item) => item.runAs || "user"),
    ...extraUsers,
  ]);
  for (const user of users) {
    const old = await cron(user);
    save(`cron-backup-${user}-${Date.now()}`, old);
    pruneCronBackups(user);
    const lines = old
      .split("\n")
      .filter((line) => !line.includes(CRON_MARKER));
    while (lines.length && !lines.at(-1)) lines.pop();
    for (const schedule of items.filter(
      (item) => (item.runAs || "user") === user,
    )) {
      const command = scheduleCommand(schedule, available.find((item) => item.id === schedule.scriptId), user);
      if (schedule.enabled && command) lines.push(cronLine(schedule, command, scheduleLog(user), user !== "root"));
    }
    const data = lines.join("\n") + "\n";
    if (user === "root") {
      await runInput(["sudo", "-n", ROOT_CRON_HELPER, "install"], data, 15000);
      invalidateRootStatus();
    } else await runInput(["crontab", "-"], data, 15000);
  }
}
// Scheduled jobs append all their output to their account's schedule log. Once
// it passes the limit only its end is kept. The SSH user's log is rewritten in
// place, because cron jobs may hold it open for appending. Root's log cannot be
// written by the SSH user, so it is replaced instead; a root job running at
// that moment keeps writing the old file and its end marker is lost.
const SCHEDULE_LOG_MAX_BYTES = 5 * 1024 * 1024;
const SCHEDULE_LOG_KEEP_BYTES = 1024 * 1024;
const TRIM_LOG_SCRIPT = '[ -f "$1" ] || exit 0; size=$(stat -c %s -- "$1") || exit 0; [ "$size" -gt "$2" ] || exit 0; tail -c "$3" -- "$1" > "$1.trim" || exit 0; if [ -w "$1" ]; then cat -- "$1.trim" > "$1"; rm -f -- "$1.trim"; else mv -f -- "$1.trim" "$1"; fi';
const CRON_USERS: CronUser[] = ["user", "root"];
export function trimScheduleLog() {
  return Promise.all(CRON_USERS.map((user) =>
    run(["sh", "-c", TRIM_LOG_SCRIPT, "sh", scheduleLog(user), String(SCHEDULE_LOG_MAX_BYTES), String(SCHEDULE_LOG_KEEP_BYTES)])));
}
// The latest start and end markers in the schedule logs, or null when there is
// no log to read. The logs do not exist until the first scheduled run, which is
// not a failure. The jobs' own output shares the files, so the markers are
// picked out on the server: a refresh then transfers a few lines instead of the
// logs' ends. The leading empty line tells a log without markers from a missing
// log. The folder is created here as well, so that root's schedules, which do
// not create it, are logged again soon after a restart emptied /tmp.
const SCHEDULE_MARKERS_SCRIPT = 'mkdir -p -- "$1" 2>/dev/null; shift; found=; for log in "$@"; do [ -f "$log" ] || continue; [ -n "$found" ] || echo; found=1; grep -a "^MEDIA_DASHBOARD_" -- "$log" | tail -n 4000; done; exit 0';
export function readScheduleLog() {
  return run(["sh", "-c", SCHEDULE_MARKERS_SCRIPT, "sh", serverSettings().remoteLogs, ...CRON_USERS.map(scheduleLog)]).then((output) => output || null, () => null);
}
// Parses the schedule log; pass the log when a snapshot has already read it.
export async function collectCronRuns(log?: string | null) {
  const output = log === undefined ? await readScheduleLog() : log;
  if (output === null) return cronRuns();
  const labels = new Map(schedules().map((item) => [item.id, item.label]));
  const label = (id: string) => labels.get(id) || "Schedule";
  const active = new Map<string, CronRun>(); const parsed: CronRun[] = [];
  for (const line of output.split("\n")) {
    const start = /^MEDIA_DASHBOARD_START\s+(\S+)\s+(.+)$/.exec(line);
    if (start) { active.set(start[1], { scheduleId: start[1], label: label(start[1]), startedAt: start[2], status: "running" }); continue; }
    const end = /^MEDIA_DASHBOARD_END\s+(\S+)\s+(\S+)\s+(\d+)$/.exec(line);
    if (end) { const item = active.get(end[1]) || { scheduleId: end[1], label: label(end[1]), startedAt: end[2], status: "running" as const }; parsed.push({ ...item, completedAt: end[2], exitCode: Number(end[3]), status: end[3] === "0" ? "success" : "failed" }); active.delete(end[1]); }
  }
  // The two logs are read one after the other; put their runs back in order.
  const time = (value?: string) => Date.parse(value || "") || 0;
  parsed.sort((a, b) => time(a.completedAt) - time(b.completedAt));
  const all = [...parsed, ...[...active.values()].sort((a, b) => time(a.startedAt) - time(b.startedAt))].slice(-500).reverse();
  const previous = cronRuns();
  if (JSON.stringify(all) !== JSON.stringify(previous)) {
    // Announce only what ended since the last collection; the first collection
    // establishes what is already known. A run seen while it was still going
    // is announced once it has ended.
    const key = (run: CronRun) => `${run.scheduleId} ${run.startedAt} ${run.status}`;
    const known = new Set(previous.map(key));
    const owned = new Map(schedules().map((item) => [item.id, item]));
    if (previous.length)
      for (const run of all) {
        if (known.has(key(run))) continue;
        // Named after what runs: the script, or the command; the schedule's
        // label ("Every 5 minutes") follows.
        const schedule = owned.get(run.scheduleId);
        const script = scripts().find((item) => item.id === schedule?.scriptId);
        const name = script?.name || schedule?.command || run.label;
        if (run.status === "failed")
          emitDashboardEvent({ type: "cron-failed", severity: "critical", title: `Scheduled run failed: ${name}`, message: `${run.label}, started ${run.startedAt}, exit code ${run.exitCode ?? "unknown"}${run.exitCode === 124 && script?.timeLimitMinutes ? `: it took longer than its time limit of ${script.timeLimitMinutes} minutes` : ""}.` });
        else if (run.status === "success" && script?.notifySuccess)
          emitDashboardEvent({ type: "script-succeeded", severity: "success", title: `Scheduled run finished: ${name}`, message: `${run.label}, started ${run.startedAt}, ended ${run.completedAt}.` });
      }
    save("cron-runs", all);
  }
  return all;
}
