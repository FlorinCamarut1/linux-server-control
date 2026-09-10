import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  randomUUID,
} from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  appendFileSync,
  openSync,
} from "node:fs";
import path from "node:path";
export const DATA = process.env.DATA_DIR || "/app/data";
export type ServerSettings = {
  sshTarget: string;
  scriptRoot: string;
  allowedPaths: string[];
  remoteLogs: string;
  metricsRetentionDays: number;
};
const defaultServerSettings = (): ServerSettings => {
  const scriptRoot = process.env.SCRIPT_ROOT || "/home";
  return {
    sshTarget: process.env.SSH_TARGET || "",
    scriptRoot,
    allowedPaths: [...new Set((process.env.ALLOWED_PATHS || scriptRoot).split(",").map((item) => item.trim().replace(/\/$/, "")).filter((item) => item.startsWith("/")))],
    remoteLogs: process.env.REMOTE_LOGS || "/tmp/media-dashboard",
    metricsRetentionDays: Math.max(1, Math.min(365, Number(process.env.METRICS_RETENTION_DAYS || 30) || 30)),
  };
};
function cleanPath(value: string) {
  const cleaned = value.trim().replace(/\/$/, "");
  if (!cleaned.startsWith("/") || /[\r\n\0]/.test(cleaned)) throw Error("Use absolute paths only");
  return cleaned;
}
export function serverSettings(): ServerSettings {
  const saved = read<Partial<ServerSettings>>("server-settings", {});
  const defaults = defaultServerSettings();
  return {
    sshTarget: typeof saved.sshTarget === "string" ? saved.sshTarget : defaults.sshTarget,
    scriptRoot: typeof saved.scriptRoot === "string" ? saved.scriptRoot : defaults.scriptRoot,
    allowedPaths: Array.isArray(saved.allowedPaths) && saved.allowedPaths.length ? saved.allowedPaths : defaults.allowedPaths,
    remoteLogs: typeof saved.remoteLogs === "string" ? saved.remoteLogs : defaults.remoteLogs,
    metricsRetentionDays: typeof saved.metricsRetentionDays === "number" ? saved.metricsRetentionDays : defaults.metricsRetentionDays,
  };
}
export function updateServerSettings(input: Partial<ServerSettings>) {
  const current = serverSettings();
  const sshTarget = (input.sshTarget ?? current.sshTarget).trim();
  if (sshTarget && !/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.:-]+$/.test(sshTarget))
    throw Error("SSH target must look like user@host");
  const scriptRoot = cleanPath(input.scriptRoot ?? current.scriptRoot);
  const allowedPaths = (input.allowedPaths ?? current.allowedPaths).map(cleanPath);
  if (!allowedPaths.length) throw Error("Keep at least one allowed path");
  const retention = Number(input.metricsRetentionDays ?? current.metricsRetentionDays);
  if (!Number.isInteger(retention) || retention < 1 || retention > 365) throw Error("Metric retention must be between 1 and 365 days");
  const settings = { sshTarget, scriptRoot, allowedPaths: [...new Set(allowedPaths)], remoteLogs: cleanPath(input.remoteLogs ?? current.remoteLogs), metricsRetentionDays: retention };
  save("server-settings", settings);
  return settings;
}
export function allowedRoots() { return serverSettings().allowedPaths; }
mkdirSync(DATA, { recursive: true });
export type Script = {
  id: string;
  name: string;
  path: string;
  cron: string;
  folder?: string;
  runAs?: "user" | "root";
  argumentHint?: string;
  runOptions?: RunOption[];
};
export type RunOption = {
  label: string;
  value: string;
  description: string;
  needsFile?: boolean;
};
export type Schedule = {
  id: string;
  scriptId: string;
  expression: string;
  label: string;
  enabled: boolean;
  runAs?: "user" | "root";
  command?: string;
};
export type Session = { device: string; expires: number; created: number };
export type ScriptRun = {
  id: string; scriptId: string; scriptName: string; startedAt: string;
  completedAt?: string; exitCode?: number; durationMs?: number; arguments: string;
  status: "running" | "success" | "failed"; logPath: string;
};
export type AlertRule = {
  id: string; name: string; metric: "temperature" | "cpu" | "ram" | "disk" | "failedScripts" | "stoppedContainers";
  threshold: number; enabled: boolean; cooldownMinutes: number; lastTriggeredAt?: number;
};
export type MetricSample = { at: number; cpu: number; ram: number; temperature: number | null; disk: number };
export type CronRun = { scheduleId: string; label: string; startedAt: string; completedAt?: string; exitCode?: number; status: "running" | "success" | "failed" };
export const sessions = new Map<string, Session>();
export function read<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path.join(DATA, name + ".json"), "utf8"));
  } catch {
    return fallback;
  }
}
export function save(name: string, value: unknown) {
  const p = path.join(DATA, name + ".json"),
    t = p + ".tmp";
  writeFileSync(t, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(t, p);
}
export function loadSessions() {
  const stored = read<Record<string, Session>>("sessions", {});
  const now = Date.now();
  for (const [id, session] of Object.entries(stored))
    if (session.expires > now) sessions.set(id, session);
}
export function persistSessions() {
  save("sessions", Object.fromEntries(sessions));
}
export function scriptRuns() { return read<ScriptRun[]>("script-runs", []); }
export function alertRules() { return read<AlertRule[]>("alerts", []); }
export function metricSamples() { return read<MetricSample[]>("metrics", []); }
export function monitoredPaths() {
  const configured = read<string[]>("monitored-paths", []);
  if (configured.length) return configured;
  return [...new Set((process.env.MONITORED_PATHS || "/mnt/storage").split(",").map((item) => item.trim().replace(/\/$/, "")).filter((item) => item.startsWith("/")))];
}
export function addMonitoredPath(input: string) {
  const requested = input.trim().replace(/\/$/, "");
  if (!requested.startsWith("/") || /[\r\n\0]/.test(requested)) throw Error("Enter an absolute storage path");
  const resolved = run(["realpath", "-e", requested]).trim(); run(["test", "-d", resolved]);
  const all = monitoredPaths(); if (!all.includes(resolved)) save("monitored-paths", [...all, resolved]);
  audit("monitor storage path " + resolved); return resolved;
}
export function removeMonitoredPath(input: string) {
  const all = monitoredPaths().filter((item) => item !== input);
  if (!all.length) throw Error("Keep at least one monitored storage path");
  save("monitored-paths", all); audit("stop monitoring storage path " + input);
}
export function cronRuns() { return read<CronRun[]>("cron-runs", []); }
export function recordMetricSample(stats: SystemStats) {
  const retentionDays = serverSettings().metricsRetentionDays;
  const cutoff = Date.now() - retentionDays * 86400000;
  const sample: MetricSample = { at: Date.now(), cpu: stats.cpuUsagePercent, ram: stats.memoryTotalBytes ? (stats.memoryUsedBytes / stats.memoryTotalBytes) * 100 : 0, temperature: stats.temperatureC, disk: stats.diskUsedPercent };
  const all = [...metricSamples().filter((item) => item.at > cutoff), sample].slice(-10000);
  save("metrics", all);
  return all;
}
export function evaluateAlerts(snapshot: { stats: SystemStats; containers: { State: string }[] }) {
  const failed = scriptRuns().filter((item) => item.status === "failed").length;
  const stopped = snapshot.containers.filter((item) => item.State !== "running").length;
  const values: Record<AlertRule["metric"], number> = {
    temperature: snapshot.stats.temperatureC ?? 0, cpu: snapshot.stats.cpuUsagePercent,
    ram: snapshot.stats.memoryTotalBytes ? snapshot.stats.memoryUsedBytes / snapshot.stats.memoryTotalBytes * 100 : 0,
    disk: snapshot.stats.diskUsedPercent, failedScripts: failed, stoppedContainers: stopped,
  };
  const now = Date.now();
  const triggered: AlertRule[] = [];
  const updated = alertRules().map((rule) => {
    const cool = rule.cooldownMinutes * 60000;
    if (rule.enabled && values[rule.metric] >= rule.threshold && (!rule.lastTriggeredAt || now - rule.lastTriggeredAt >= cool)) {
      const next = { ...rule, lastTriggeredAt: now };
      triggered.push(next); audit(`alert triggered ${rule.name}: ${values[rule.metric]}`); return next;
    }
    return rule;
  });
  if (triggered.length) save("alerts", updated);
  return { values, triggered };
}
export function exportConfiguration() {
  return { version: 1, exportedAt: new Date().toISOString(), scripts: scripts(), folders: folders(), schedules: schedules(), devices: read("devices", {}), alerts: alertRules(), serverSettings: serverSettings() };
}
export function restoreConfiguration(payload: Record<string, unknown>) {
  if (payload.version !== 1 || !Array.isArray(payload.scripts) || !Array.isArray(payload.schedules) || !Array.isArray(payload.folders) || !Array.isArray(payload.alerts)) throw Error("Invalid configuration backup");
  save("scripts", payload.scripts); save("schedules", payload.schedules); save("folders", payload.folders); save("alerts", payload.alerts);
  if (payload.devices && typeof payload.devices === "object") save("devices", payload.devices);
  if (payload.serverSettings && typeof payload.serverSettings === "object") updateServerSettings(payload.serverSettings as Partial<ServerSettings>);
  syncCron(payload.schedules as Schedule[]); audit("configuration restored");
}
const ssh = (args: string[]): [string, string[]] => {
  const target = serverSettings().sshTarget;
  return target
    ? [
        "ssh",
        [
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=8",
          "-o",
          "StrictHostKeyChecking=yes",
          "-i",
          "/run/ssh/id_ed25519",
          "-o",
          "UserKnownHostsFile=/run/ssh/known_hosts",
          target,
          shell(args),
        ],
      ]
    : [args[0], args.slice(1)];
};
export async function testServerConnection() {
  const target = serverSettings().sshTarget;
  if (!target) return { host: "local", mode: "local" as const };
  const host = (await runAsync(["hostname"], 12000)).trim();
  return { host, mode: "ssh" as const, target };
}
export function shell(args: string[]) {
  return args.map((x) => "'" + x.replaceAll("'", "'\\''") + "'").join(" ");
}
export function run(args: string[], timeout = 30000) {
  const [c, a] = ssh(args);
  return execFileSync(c, a, { encoding: "utf8", timeout, maxBuffer: 4e6 });
}
const execFileAsync = promisify(execFile);
export async function runAsync(args: string[], timeout = 30000) {
  const [command, arguments_] = ssh(args);
  const { stdout } = await execFileAsync(command, arguments_, {
    encoding: "utf8", timeout, maxBuffer: 4e6,
  });
  return stdout;
}
export function runInput(args: string[], input: string, timeout = 30000) {
  const [c, a] = ssh(args);
  return execFileSync(c, a, { encoding: "utf8", input, timeout, maxBuffer: 4e6 });
}
export type SystemStats = {
  temperatureC: number | null;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  memoryAvailableBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  diskUsedPercent: number;
  storage: {
    path: string;
    usedBytes: number | null;
    totalBytes: number | null;
    usedPercent: number | null;
  }[];
  uptimeSeconds: number;
  cpuUsagePercent: number;
  cpuCores: number;
};
export async function systemStats(): Promise<SystemStats> {
  const output = await runAsync([
    "bash",
    "-lc",
    [
      'read -r mem_total mem_used mem_available < <(free -b | awk \'/^Mem:/ {print $2, $3, $7}\')',
      'read -r disk_total disk_used disk_pct < <(df -B1 -P / | awk \'NR==2 {gsub(/%/, "", $5); print $2, $3, $5}\')',
      'read -r _ cpu_user cpu_nice cpu_system cpu_idle cpu_iowait cpu_irq cpu_softirq cpu_steal _ < /proc/stat',
      'cpu_total_1=$((cpu_user + cpu_nice + cpu_system + cpu_idle + cpu_iowait + cpu_irq + cpu_softirq + cpu_steal))',
      'cpu_idle_1=$((cpu_idle + cpu_iowait))',
      'sleep 0.15',
      'read -r _ cpu_user cpu_nice cpu_system cpu_idle cpu_iowait cpu_irq cpu_softirq cpu_steal _ < /proc/stat',
      'cpu_total_2=$((cpu_user + cpu_nice + cpu_system + cpu_idle + cpu_iowait + cpu_irq + cpu_softirq + cpu_steal))',
      'cpu_idle_2=$((cpu_idle + cpu_iowait))',
      'cpu_delta=$((cpu_total_2 - cpu_total_1))',
      'cpu_idle_delta=$((cpu_idle_2 - cpu_idle_1))',
      'cpu_pct=$(awk -v total="$cpu_delta" -v idle="$cpu_idle_delta" \'BEGIN {if (total > 0) printf "%.1f", 100 * (total - idle) / total; else print "0.0"}\')',
      'uptime_s=$(cut -d. -f1 /proc/uptime)',
      'cores=$(nproc)',
      'temp=$(command -v sensors >/dev/null && sensors "coretemp-*" -u 2>/dev/null | awk \'/_input:/ {if ($2 > max) max=$2} END {if (max) printf "%.1f", max}\')',
      'if [ -z "$temp" ]; then temp=$(find -L /sys/class/thermal /sys/class/hwmon -type f \\( -name temp -o -name "temp*_input" \\) -readable -exec cat {} + 2>/dev/null | awk \'$1 ~ /^[0-9]+([.][0-9]+)?$/ {v=$1; if (v > 1000) v=v/1000; if (v > 0 && v < 150 && v > max) max=v} END {if (max) printf "%.1f", max}\'); fi',
      'printf "temperatureC=%s\\nmemoryUsedBytes=%s\\nmemoryTotalBytes=%s\\nmemoryAvailableBytes=%s\\ndiskUsedBytes=%s\\ndiskTotalBytes=%s\\ndiskUsedPercent=%s\\nuptimeSeconds=%s\\ncpuUsagePercent=%s\\ncpuCores=%s\\n" "$temp" "$mem_used" "$mem_total" "$mem_available" "$disk_used" "$disk_total" "$disk_pct" "$uptime_s" "$cpu_pct" "$cores"',
    ].join("; "),
  ]);
  const values = Object.fromEntries(
    output
      .trim()
      .split("\n")
      .map((line) => line.split("=", 2)),
  );
  const number = (key: string) => {
    const value = Number(values[key]);
    return Number.isFinite(value) ? value : 0;
  };
  const storage = await Promise.all(monitoredPaths().map(async (storagePath) => {
    try {
      const fields = (await runAsync(["df", "-B1", "-P", storagePath]))
        .trim()
        .split("\n")
        .at(-1)!
        .trim()
        .split(/\s+/);
      const totalBytes = Number(fields[1]);
      const usedBytes = Number(fields[2]);
      const usedPercent = Number(fields[4]?.replace("%", ""));
      if (![totalBytes, usedBytes, usedPercent].every(Number.isFinite)) throw Error();
      return { path: storagePath, usedBytes, totalBytes, usedPercent };
    } catch {
      return { path: storagePath, usedBytes: null, totalBytes: null, usedPercent: null };
    }
  }));
  return {
    temperatureC: values.temperatureC ? number("temperatureC") : null,
    memoryUsedBytes: number("memoryUsedBytes"),
    memoryTotalBytes: number("memoryTotalBytes"),
    memoryAvailableBytes: number("memoryAvailableBytes"),
    diskUsedBytes: number("diskUsedBytes"),
    diskTotalBytes: number("diskTotalBytes"),
    diskUsedPercent: number("diskUsedPercent"),
    storage,
    uptimeSeconds: number("uptimeSeconds"),
    cpuUsagePercent: number("cpuUsagePercent"),
    cpuCores: number("cpuCores"),
  };
}
type CronUser = "user" | "root";
const rootCronHelper = "/usr/local/sbin/media-dashboard-root-cron";
const rootScriptHelper = "/usr/local/sbin/media-dashboard-root-run";
// Share only concurrent read requests. Completed snapshots are never cached,
// so a refresh after a mutation always reads current host state.
let pendingSnapshot: ReturnType<typeof collectSnapshot> | undefined;
async function collectSnapshot() {
  const [containers, userCron, root, rootScript, time, stats] = await Promise.all([
    runAsync(["docker", "ps", "-a", "--size", "--format", "{{json .}}"])
      .then((output) => output.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))),
    runAsync(["crontab", "-l"]).catch(() => ""),
    Promise.all([
      runAsync(["sudo", "-n", rootCronHelper, "list"]),
      runAsync(["sudo", "-n", rootCronHelper, "system-list"]),
    ]).then(([cron, system]) => ({ available: true, cron, system }))
      .catch(() => ({ available: false, cron: "", system: "" })),
    runAsync(["sudo", "-n", rootScriptHelper, "status"])
      .then(() => ({ available: true })).catch(() => ({ available: false })),
    runAsync(["date", "+%d.%m.%Y %H:%M:%S %Z"]).then((value) => value.trim()),
    systemStats(),
  ]);
  return { containers, cron: userCron, root, rootScript, time, stats };
}
export function hostSnapshot() {
  if (!pendingSnapshot) {
    pendingSnapshot = collectSnapshot().finally(() => { pendingSnapshot = undefined; });
  }
  return pendingSnapshot;
}
export function cron(user: CronUser = "user") {
  try {
    return user === "root"
      ? run(["sudo", "-n", rootCronHelper, "list"])
      : run(["crontab", "-l"]);
  } catch {
    return "";
  }
}
export function rootCronStatus() {
  try {
    return {
      available: true,
      cron: run(["sudo", "-n", rootCronHelper, "list"]),
      system: run(["sudo", "-n", rootCronHelper, "system-list"]),
    };
  } catch {
    return { available: false, cron: "", system: "" };
  }
}
export function rootScriptStatus() {
  try {
    run(["sudo", "-n", rootScriptHelper, "status"]);
    return { available: true };
  } catch {
    return { available: false };
  }
}
export function scripts() {
  return read<Script[]>("scripts", []);
}
export function folders() {
  const stored = read<string[]>("folders", []);
  const inferred = scripts()
    .map((script) => script.folder || "")
    .filter(Boolean);
  return [...new Set([...stored, ...inferred])].sort((a, b) =>
    a.localeCompare(b),
  );
}
export function addFolder(input: string) {
  const name = input.trim().replace(/\s+/g, " ").slice(0, 60);
  if (!name) throw Error("Enter a folder name");
  if (name === "Unfiled") throw Error("This folder name is reserved");
  if (/[\r\n]/.test(name)) throw Error("The folder name must be one line");
  const all = folders();
  if (!all.includes(name)) save("folders", [...all, name]);
}
export function schedules(): Schedule[] {
  const stored = read<Schedule[]>("schedules", []).map((item) => ({
    ...item,
    runAs: item.runAs === "root" ? ("root" as const) : ("user" as const),
  }));
  if (stored.length) return stored;
  return scripts()
    .filter((script) => script.cron)
    .map((script) => ({
      id: `legacy-${script.id}`,
      scriptId: script.id,
      expression: script.cron,
      label: "Imported schedule",
      enabled: true,
      runAs: "user",
    }));
}
export function validCron(x: string) {
  if (!x) return;
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
export function syncCron(items: Schedule[], extraUsers: CronUser[] = []) {
  const remote = serverSettings().remoteLogs;
  run(["mkdir", "-p", remote]);
  const available = scripts();
  const users = new Set<CronUser>([
    ...items.map((item) => item.runAs || "user"),
    ...extraUsers,
  ]);
  for (const user of users) {
    const old = cron(user);
    save(`cron-backup-${user}-${Date.now()}`, old);
    const lines = old
      .split("\n")
      .filter((line) => !line.includes("# media-dashboard:"));
    for (const schedule of items.filter(
      (item) => (item.runAs || "user") === user,
    )) {
      const script = available.find((item) => item.id === schedule.scriptId);
      if (schedule.enabled && (script || schedule.command))
        // The markers make scheduled work observable without granting cron any additional privileges.
        lines.push(
          `${schedule.expression} ( printf 'MEDIA_DASHBOARD_START ${schedule.id} %s\\n' "$(date -Is)"; ${schedule.command ? schedule.command : `/bin/bash ${shell([script!.path])}`} ; code=$?; printf 'MEDIA_DASHBOARD_END ${schedule.id} %s %s\\n' "$(date -Is)" "$code"; exit "$code" ) >> ${shell([remote + "/schedules.log"])} 2>&1 # media-dashboard:${schedule.id}`,
        );
    }
    const data = lines.join("\n") + "\n";
    if (user === "root")
      runInput(["sudo", "-n", rootCronHelper, "install"], data, 15000);
    else runInput(["crontab", "-"], data, 15000);
  }
}
export function collectCronRuns() {
  let output = "";
  try { output = run(["tail", "-n", "4000", path.posix.join(serverSettings().remoteLogs, "schedules.log")]); } catch { return cronRuns(); }
  const active = new Map<string, CronRun>(); const parsed: CronRun[] = [];
  for (const line of output.split("\n")) {
    const start = /^MEDIA_DASHBOARD_START\s+(\S+)\s+(.+)$/.exec(line);
    if (start) { active.set(start[1], { scheduleId: start[1], label: schedules().find((item) => item.id === start[1])?.label || "Schedule", startedAt: start[2], status: "running" }); continue; }
    const end = /^MEDIA_DASHBOARD_END\s+(\S+)\s+(\S+)\s+(\d+)$/.exec(line);
    if (end) { const item = active.get(end[1]) || { scheduleId: end[1], label: schedules().find((x) => x.id === end[1])?.label || "Schedule", startedAt: end[2], status: "running" as const }; parsed.push({ ...item, completedAt: end[2], exitCode: Number(end[3]), status: end[3] === "0" ? "success" : "failed" }); active.delete(end[1]); }
  }
  const all = [...parsed, ...active.values()].slice(-500).reverse(); save("cron-runs", all); return all;
}
export function hash(password: string, salt: string) {
  return scryptSync(password, Buffer.from(salt, "hex"), 64, {
    N: 16384,
    r: 8,
    p: 1,
  }).toString("hex");
}
export function secureEqual(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function digest(x: string) {
  return createHash("sha256").update(x).digest("hex");
}
export function token() {
  return randomBytes(32).toString("base64url");
}
export function audit(x: string) {
  appendFileSync(
    path.join(DATA, "audit.log"),
    new Date().toISOString() + " " + x + "\n",
  );
}
function parseArguments(value: string) {
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
function isAllowedPath(value: string) {
  return allowedRoots().some((root) => value === root || value.startsWith(root + "/"));
}
function resolveAllowedDirectory(requested: string) {
  const directory = requested
    ? run(["realpath", "-e", requested]).trim()
    : allowedRoots()[0];
  if (!directory || !isAllowedPath(directory))
    throw Error("This folder is outside the allowed locations");
  run(["test", "-d", directory]);
  return directory;
}
function resolveSelectedFile(requested: string) {
  const resolved = run(["realpath", "-e", requested]).trim();
  if (!isAllowedPath(resolved))
    throw Error("The selected file must be inside an allowed location");
  run(["test", "-f", resolved]);
  return resolved;
}
const MAX_EDITABLE_FILE_BYTES = 512 * 1024;
export function readEditableFile(requested: string) {
  const resolved = resolveSelectedFile(requested);
  const size = Number(run(["stat", "-c", "%s", resolved]).trim());
  if (!Number.isFinite(size) || size > MAX_EDITABLE_FILE_BYTES)
    throw Error("Only text files up to 512 KB can be edited here");
  const mime = run(["file", "--brief", "--mime-type", resolved]).trim();
  if (!mime.startsWith("text/") && !mime.endsWith("json") && !mime.endsWith("xml"))
    throw Error("This file is not a supported text file");
  return { path: resolved, content: run(["cat", resolved]) };
}
export function saveEditableFile(requested: string, content: string) {
  const resolved = resolveSelectedFile(requested);
  if (Buffer.byteLength(content, "utf8") > MAX_EDITABLE_FILE_BYTES)
    throw Error("Only text files up to 512 KB can be saved here");
  if (content.includes("\0")) throw Error("Binary content cannot be saved here");
  runInput(["sh", "-c", 'cat > "$1"', "sh", resolved], content, 15000);
  audit("edited file " + resolved);
}
export function deleteEditableFile(requested: string) {
  const resolved = resolveSelectedFile(requested);
  run(["rm", "-f", "--", resolved]);
  audit("deleted file " + resolved);
}
export function runScript(s: Script, rawArguments = "", selectedFile = "") {
  const scriptArguments = parseArguments(rawArguments);
  if (selectedFile) {
    const fileIndex = scriptArguments.indexOf("--file");
    scriptArguments.splice(
      fileIndex >= 0 ? fileIndex + 1 : scriptArguments.length,
      0,
      resolveSelectedFile(selectedFile),
    );
  }
  if (s.runAs === "root" && !rootScriptStatus().available)
    throw Error("Root script access has not been enabled on this server");
  const command =
      s.runAs === "root"
        ? ["sudo", "-n", rootScriptHelper, "run", s.path, ...scriptArguments]
        : ["/bin/bash", s.path, ...scriptArguments],
    runId = randomUUID(),
    log = path.join(DATA, "runs", runId + ".log"),
    [cmd, args] = ssh(command);
  mkdirSync(path.dirname(log), { recursive: true });
  const started = Date.now();
  const record: ScriptRun = {
    id: runId, scriptId: s.id, scriptName: s.name, startedAt: new Date(started).toISOString(),
    arguments: rawArguments, status: "running", logPath: log,
  };
  save("script-runs", [record, ...scriptRuns()].slice(0, 2000));
  const out = openSync(log, "a");
  const child = spawn(cmd, args, {
    stdio: ["ignore", out, out],
  });
  child.on("close", (code) => {
    const finished = Date.now();
    const all = scriptRuns().map((item) => item.id === runId ? {
      ...item, completedAt: new Date(finished).toISOString(), durationMs: finished - started,
      exitCode: code ?? 1, status: code === 0 ? "success" as const : "failed" as const,
    } : item);
    save("script-runs", all);
    audit(`script ${s.name} ${code === 0 ? "completed" : "failed"} (${runId})`);
  });
  child.unref();
  audit("run script " + s.name + " (" + runId + ")");
  return record;
}
export type ScriptBrowserEntry = {
  name: string;
  path: string;
  type: "directory" | "script";
};
const fileOperation = String.raw`
import json, os, sys, shutil, subprocess
request = json.load(sys.stdin)
roots = [os.path.realpath(root) for root in request["roots"]]
target = os.path.realpath(request["path"] or roots[0])
def inside(value, root):
    return value == root or value.startswith(root.rstrip("/") + "/")
def allowed(value):
    return any(inside(value, root) for root in roots)
def protected(value):
    return any(inside(root, value) for root in roots)
if not any(inside(target, root) for root in roots):
    raise ValueError("This path is outside the allowed locations")
if request["action"] == "delete":
    if not request["path"] or protected(target):
        raise ValueError("Allowed locations and their parents cannot be deleted")
    if os.path.islink(request["path"]):
        raise ValueError("Deleting symbolic links is not supported")
    if os.path.isdir(target):
        shutil.rmtree(target)
    elif os.path.isfile(target):
        os.unlink(target)
    else:
        raise ValueError("File or folder not found")
    print(json.dumps({"ok": True}))
elif request["action"] == "create":
    parent = target
    name = request.get("name") or ""
    if not name or name in (".", "..") or "/" in name or "\\" in name or len(name) > 255:
        raise ValueError("Enter a valid name")
    if not allowed(parent) or not os.path.isdir(parent):
        raise ValueError("Choose an allowed destination folder")
    output = os.path.realpath(os.path.join(parent, name))
    if not allowed(output) or os.path.exists(output):
        raise ValueError("A file or folder with this name already exists")
    if request.get("kind") == "folder":
        os.mkdir(output)
    else:
        open(output, "x").close()
    print(json.dumps({"ok": True, "path": output}))
elif request["action"] in ("copy", "move", "rename"):
    source = os.path.realpath(request.get("source") or "")
    if not source or not allowed(source) or protected(source):
        raise ValueError("The selected file or folder cannot be changed")
    if os.path.islink(request.get("source") or ""):
        raise ValueError("Symbolic links are not supported")
    if not (os.path.isfile(source) or os.path.isdir(source)):
        raise ValueError("File or folder not found")
    if request["action"] == "rename":
        name = request.get("name") or ""
        if not name or name in (".", "..") or "/" in name or "\\" in name or len(name) > 255:
            raise ValueError("Enter a valid name")
        destination = os.path.dirname(source)
        output = os.path.realpath(os.path.join(destination, name))
    else:
        destination = os.path.realpath(request.get("destination") or "")
        if not allowed(destination) or not os.path.isdir(destination):
            raise ValueError("Choose an allowed destination folder")
        output = os.path.realpath(os.path.join(destination, os.path.basename(source)))
    if not allowed(output) or output == source:
        raise ValueError("Choose a different allowed destination")
    if os.path.exists(output):
        raise ValueError("A file or folder with this name already exists there")
    if os.path.isdir(source) and inside(destination, source):
        raise ValueError("A folder cannot be pasted inside itself")
    if request["action"] == "copy":
        if os.path.isdir(source):
            shutil.copytree(source, output, symlinks=True)
        else:
            shutil.copy2(source, output, follow_symlinks=False)
    else:
        shutil.move(source, output)
    print(json.dumps({"ok": True, "path": output}))
else:
    entries = []
    sizes = {}
    if request["action"] == "sizes":
        try:
            measured = subprocess.run(
                ["du", "-b", "--max-depth=1", "--", target],
                capture_output=True, text=True, timeout=20, check=False)
            for line in measured.stdout.splitlines():
                amount, name = line.split("\t", 1)
                sizes[os.path.realpath(name)] = int(amount)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            pass
        print(json.dumps({"path": target, "sizes": sizes}))
        sys.exit(0)
    with os.scandir(target) as items:
        for item in items:
            if item.is_dir(follow_symlinks=False):
                kind = "directory"
            elif item.is_file(follow_symlinks=False):
                if request["scripts"] and not item.name.endswith(".sh"):
                    continue
                kind = "script" if request["scripts"] else "file"
            else:
                continue
            size = sizes.get(os.path.realpath(item.path)) if kind == "directory" else item.stat(follow_symlinks=False).st_size
            entries.append({"name": item.name, "path": item.path, "type": kind, "size": size})
    query = str(request.get("search") or "").lower()
    if query:
        entries = [item for item in entries if query in item["name"].lower()]
    ordering = request.get("sort") or "name"
    if ordering == "size":
        entries.sort(key=lambda item: (item["type"] != "directory", item.get("size") is None, item.get("size") or 0, item["name"].lower()))
    else:
        entries.sort(key=lambda item: (item["type"] != "directory", item["name"].lower()))
    offset = max(0, int(request.get("offset") or 0))
    limit = min(300, max(1, int(request.get("limit") or 100)))
    parent = os.path.dirname(target)
    print(json.dumps({"path": target, "roots": roots,
        "parent": parent if target not in roots and any(inside(parent, root) for root in roots) else None,
        "entries": entries[offset:offset + limit], "total": len(entries), "offset": offset, "limit": limit}))
`;
async function remoteFileOperation(request: Record<string, unknown>) {
  const [command, args] = ssh(["python3", "-c", fileOperation]);
  return new Promise<any>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let output = "", error = "";
    const timeout = setTimeout(() => { child.kill(); reject(Error("File operation timed out")); }, 30000);
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { error += chunk; });
    child.on("error", (reason) => { clearTimeout(timeout); reject(reason); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) return reject(Error(error.trim().split("\n").pop() || "File operation failed"));
      try { resolve(JSON.parse(output)); } catch { reject(Error("Invalid file response")); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ ...request, roots: allowedRoots() }));
  });
}
export function browseScripts(requested = "") {
  return remoteFileOperation({ path: requested, action: "browse", scripts: true });
}
export function browseFiles(requested = "", options: { search?: string; sort?: string; offset?: number; limit?: number } = {}) {
  return remoteFileOperation({ path: requested, action: "browse", scripts: false, ...options });
}
export function folderSizes(requested: string) {
  return remoteFileOperation({ path: requested, action: "sizes", scripts: false });
}
export async function deleteFolder(requested: string) {
  await remoteFileOperation({ path: requested, action: "delete" });
  audit("deleted folder " + requested);
}
export async function changeFile(
  action: "delete" | "copy" | "move" | "rename",
  source: string,
  destination = "",
  name = "",
) {
  const result = await remoteFileOperation({
    path: source,
    action,
    source,
    destination,
    name,
  });
  audit(`${action} ${source}${result.path ? " -> " + result.path : ""}`);
  return result;
}
export async function createFileOrFolder(directory: string, name: string, kind: "file" | "folder") {
  const result = await remoteFileOperation({ path: directory, action: "create", name, kind });
  audit(`created ${kind} ${result.path}`); return result;
}
export function addScript(input: Record<string, string>) {
  const name = (input.name || "").trim().slice(0, 80),
    requested = input.path || "",
    folder = (input.folder || "").trim().replace(/\s+/g, " ").slice(0, 60),
    expr = "",
    runAs: "user" | "root" = input.runAs === "root" ? "root" : "user";
  if (!name) throw Error("Enter a name");
  if (/[\r\n]/.test(folder)) throw Error("The folder name must be one line");
  let runOptions: RunOption[] = [];
  try {
    const parsed = JSON.parse(input.runOptions || "[]");
    if (!Array.isArray(parsed) || parsed.length > 12) throw Error();
    runOptions = parsed.map((item) => {
      const label = String(item.label || "").trim().slice(0, 80);
      const value = String(item.value || "").trim().slice(0, 500);
      const description = String(item.description || "").trim().slice(0, 180);
      const needsFile = item.needsFile === true;
      if (!label || !value || /[\r\n]/.test(label + value + description)) throw Error();
      return { label, value, description, needsFile };
    });
  } catch {
    throw Error("Each run option needs a name and an argument value");
  }
  if (folder && !folders().includes(folder)) throw Error("Choose an existing folder");
  if (runAs === "root" && !rootScriptStatus().available)
    throw Error("Root script access has not been enabled on this server");
  const resolved = run(["realpath", "-e", requested]).trim();
  if (
    !isAllowedPath(resolved) ||
    !resolved.endsWith(".sh")
  )
    throw Error(
      "The script must be an existing .sh file inside an allowed location",
    );
  run(["test", "-f", resolved]);
  const id = /^[a-f0-9-]{32,36}$/.test(input.id || "")
    ? input.id
    : randomUUID();
  const all = scripts().filter((x) => x.id !== id);
  all.push({ id, name, path: resolved, cron: expr, folder, runAs, runOptions });
  save("scripts", all);
}
export function createCustomScript(input: Record<string, string>) {
  const directory = resolveAllowedDirectory(input.directory || "");
  const filename = (input.filename || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.sh$/.test(filename))
    throw Error("Use a shell-script filename ending in .sh");
  const target = path.posix.join(directory, filename);
  if (!isAllowedPath(target)) throw Error("Choose an allowed script folder");
  try {
    run(["test", "!", "-e", target]);
  } catch {
    throw Error("A file or folder with this name already exists");
  }
  const content = input.content || "";
  if (!content.trim() || content.includes("\0") || Buffer.byteLength(content, "utf8") > 128 * 1024)
    throw Error("Enter a shell script up to 128 KB");
  const program = content.startsWith("#!")
    ? content
    : "#!/usr/bin/env bash\nset -eu\n\n" + content;
  runInput(
    ["sh", "-c", 'umask 077; cat > "$1"; chmod 700 "$1"', "sh", target],
    program,
    15000,
  );
  try {
    addScript({ ...input, path: target });
  } catch (error) {
    run(["rm", "-f", "--", target]);
    throw error;
  }
  audit("created custom script " + target);
}

// Sessions are intentionally persisted without credentials so routine restarts do not sign out every browser.
loadSessions();
