// Server health: statistics, the host snapshot, metric history, alert rules,
// the requirement checks and the background monitor.
import { randomBytes } from "node:crypto";
import { audit, emitDashboardEvent, read, save } from "./store";
import { ROOT_CRON_HELPER, ROOT_SCRIPT_HELPER, run, runAsync, serverSettings, testServerConnection } from "./ssh";
import { type AlertRule, type MetricSample, RECORD_ID, alertRules, oneLine, scriptRuns } from "./records";
import { collectCronRuns, readScheduleLog, rootHelperStatus, trimScheduleLog } from "./cron";
export function metricSamples() {
  return read<MetricSample[]>("metrics", []);
}
export const HISTORY_RANGES = { "24h": 86400000, "7d": 7 * 86400000, "30d": 30 * 86400000 } as const;
export type HistoryRange = keyof typeof HISTORY_RANGES;
const average = (values: (number | null | undefined)[]) => {
  const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
};
// Samples within the range, averaged into at most `points` equal time buckets
// so long ranges stay light to send and draw.
export function metricHistory(range: HistoryRange, points = 288, now = Date.now()) {
  const span = HISTORY_RANGES[range], from = now - span, bucket = span / points;
  const groups = new Map<number, MetricSample[]>();
  for (const sample of metricSamples()) {
    if (sample.at < from) continue;
    const index = Math.min(points - 1, Math.floor((sample.at - from) / bucket));
    const group = groups.get(index);
    if (group) group.push(sample);
    else groups.set(index, [sample]);
  }
  const paths = [...new Set(metricSamples().flatMap((sample) => Object.keys(sample.storage || {})))];
  return {
    range, from, to: now,
    samples: [...groups.entries()].sort(([a], [b]) => a - b).map(([, items]) => ({
      at: Math.round(average(items.map((item) => item.at))!),
      cpu: average(items.map((item) => item.cpu)),
      ram: average(items.map((item) => item.ram)),
      temperature: average(items.map((item) => item.temperature)),
      disk: average(items.map((item) => item.disk)),
      storage: Object.fromEntries(paths.map((storagePath) => [storagePath, average(items.map((item) => item.storage?.[storagePath]))])),
    })),
  };
}
export function metricsSummary() {
  const samples = metricSamples();
  return { latest: samples.at(-1) ?? null, count: samples.length, intervalMinutes: METRIC_INTERVAL_MS / 60000 };
}
// A storage path without its trailing slashes; "/" itself stays.
export const cleanStoragePath = (value: string) => value.trim().replace(/(.)\/+$/, "$1");
export function monitoredPaths() {
  const configured = read<string[]>("monitored-paths", []);
  if (configured.length) return configured;
  return [...new Set((process.env.MONITORED_PATHS || "/mnt/storage").split(",").map(cleanStoragePath).filter((item) => item.startsWith("/")))];
}
export async function addMonitoredPath(input: string) {
  const requested = cleanStoragePath(input);
  if (!requested.startsWith("/") || /[\r\n\0]/.test(requested)) throw Error("Enter an absolute storage path");
  let resolved: string;
  try {
    resolved = (await run(["realpath", "-e", "--", requested])).trim();
    await run(["test", "-d", resolved]);
  } catch {
    throw Error("This storage path does not exist or is not a folder");
  }
  const all = monitoredPaths(); if (!all.includes(resolved)) save("monitored-paths", [...all, resolved]);
  audit("monitor storage path " + resolved); return resolved;
}
export function removeMonitoredPath(input: string) {
  const all = monitoredPaths().filter((item) => item !== input);
  if (!all.length) throw Error("Keep at least one monitored storage path");
  save("monitored-paths", all); audit("stop monitoring storage path " + input);
}
// One sample per interval, regardless of how many browsers are polling, so the
// configured retention is what actually limits the history.
export const METRIC_INTERVAL_MS = 5 * 60 * 1000;
export function recordMetricSample(stats: SystemStats) {
  const now = Date.now();
  const existing = metricSamples();
  if (existing.length && now - existing[existing.length - 1].at < METRIC_INTERVAL_MS - 5000) return false;
  const cutoff = now - serverSettings().metricsRetentionDays * 86400000;
  const storage = Object.fromEntries((stats.storage || []).filter((item) => item.usedPercent !== null).map((item) => [item.path, item.usedPercent as number]));
  const sample: MetricSample = { at: now, cpu: stats.cpuUsagePercent, ram: stats.memoryTotalBytes ? (stats.memoryUsedBytes / stats.memoryTotalBytes) * 100 : 0, temperature: stats.temperatureC, disk: stats.diskUsedPercent, storage };
  save("metrics", [...existing.filter((item) => item.at > cutoff), sample], false);
  return true;
}
// Failed-run alerts count recent failures only; counting the whole history kept
// an alert firing forever once the threshold had been reached.
export const FAILED_RUN_WINDOW_MS = 24 * 60 * 60 * 1000;
const ALERT_LABELS: Record<AlertRule["metric"], string> = { temperature: "CPU temperature", cpu: "CPU use", ram: "RAM use", disk: "System disk use", storage: "Storage use", failedScripts: "Failed script runs in the last 24 hours", stoppedContainers: "Stopped containers" };
const ALERT_UNITS: Record<AlertRule["metric"], string> = { temperature: " °C", cpu: "%", ram: "%", disk: "%", storage: "%", failedScripts: "", stoppedContainers: "" };
export function evaluateAlerts(snapshot: { stats: SystemStats; containers: { State: string }[] }) {
  const since = Date.now() - FAILED_RUN_WINDOW_MS;
  const failed = scriptRuns().filter((item) => item.status === "failed" && Date.parse(item.startedAt) >= since).length;
  const stopped = snapshot.containers.filter((item) => item.State !== "running").length;
  // The storage rule watches every monitored path at once, through the fullest.
  let fullest: { path: string; usedPercent: number } | undefined;
  for (const item of snapshot.stats.storage || [])
    if (item.usedPercent !== null && (!fullest || item.usedPercent > fullest.usedPercent)) fullest = { path: item.path, usedPercent: item.usedPercent };
  const values: Record<AlertRule["metric"], number> = {
    temperature: snapshot.stats.temperatureC ?? 0, cpu: snapshot.stats.cpuUsagePercent,
    ram: snapshot.stats.memoryTotalBytes ? snapshot.stats.memoryUsedBytes / snapshot.stats.memoryTotalBytes * 100 : 0,
    disk: snapshot.stats.diskUsedPercent, storage: fullest?.usedPercent ?? 0, failedScripts: failed, stoppedContainers: stopped,
  };
  const now = Date.now();
  const triggered: AlertRule[] = [];
  const updated = alertRules().map((rule) => {
    const cool = rule.cooldownMinutes * 60000;
    if (rule.enabled && values[rule.metric] >= rule.threshold && (!rule.lastTriggeredAt || now - rule.lastTriggeredAt >= cool)) {
      const next = { ...rule, lastTriggeredAt: now };
      triggered.push(next); audit(`alert triggered ${rule.name}: ${values[rule.metric]}`);
      const label = rule.metric === "storage" && fullest ? `${ALERT_LABELS.storage} of ${fullest.path}` : ALERT_LABELS[rule.metric];
      emitDashboardEvent({ type: "alert", severity: "warning", title: `Alert: ${rule.name}`, message: `${label} is ${Math.round(values[rule.metric] * 10) / 10}${ALERT_UNITS[rule.metric]}, at or above the threshold of ${rule.threshold}${ALERT_UNITS[rule.metric]}.` });
      return next;
    }
    return rule;
  });
  if (triggered.length) save("alerts", updated);
  return { values, triggered };
}
const ALERT_METRICS: AlertRule["metric"][] = ["temperature", "cpu", "ram", "disk", "storage", "failedScripts", "stoppedContainers"];
export function normalizeAlert(input: Record<string, unknown>): AlertRule {
  const metric = input.metric as AlertRule["metric"];
  if (!ALERT_METRICS.includes(metric)) throw Error("Invalid alert metric");
  const threshold = Number(input.threshold), cooldownMinutes = Number(input.cooldownMinutes);
  if (!Number.isFinite(threshold) || threshold < 0 || !Number.isFinite(cooldownMinutes) || cooldownMinutes < 1 || cooldownMinutes > 10080)
    throw Error("Invalid alert values");
  const lastTriggeredAt = Number(input.lastTriggeredAt);
  return {
    id: typeof input.id === "string" && RECORD_ID.test(input.id) ? input.id : randomBytes(16).toString("hex"),
    name: oneLine(input.name, 80) || "Alert",
    metric, threshold, cooldownMinutes,
    // An unchecked form checkbox is omitted, so only an explicit true enables the rule.
    enabled: input.enabled === true || input.enabled === "true",
    ...(Number.isFinite(lastTriggeredAt) && lastTriggeredAt > 0 ? { lastTriggeredAt } : {}),
  };
}
export function saveAlert(input: Record<string, unknown>) {
  const rule = normalizeAlert(input);
  save("alerts", [...alertRules().filter((item) => item.id !== rule.id), rule]);
  audit("alert saved " + rule.id);
}
// What the dashboard needs on the server, and which feature each tool serves.
const REQUIRED_TOOLS: [tool: string, level: "error" | "warning", purpose: string][] = [
  ["bash", "error", "Health statistics and scripts need it; the dashboard cannot load without it."],
  ["free", "error", "RAM statistics need it (package procps); the dashboard cannot load without it."],
  ["df", "error", "Disk statistics need it; the dashboard cannot load without it."],
  ["python3", "warning", "The Files page and the script picker need it."],
  ["file", "warning", "The file editor needs it to recognise text files."],
  ["crontab", "warning", "Schedules need it (package cron or cronie)."],
  ["docker", "warning", "The Containers page needs it."],
];
const PREFLIGHT_SCRIPT = [
  'for tool in bash free df python3 file crontab docker; do if command -v "$tool" >/dev/null 2>&1; then echo "tool:$tool=ok"; else echo "tool:$tool=missing"; fi; done',
  'if realpath -e -- / >/dev/null 2>&1 && df -B1 -P / >/dev/null 2>&1 && du -b /dev/null >/dev/null 2>&1; then echo gnu=ok; else echo gnu=missing; fi',
  'if command -v docker >/dev/null 2>&1; then if out=$(docker ps -q 2>&1); then echo docker=ok; else echo "docker=$(printf "%s" "$out" | tail -n 1)"; fi; fi',
  'logs=$1; shift',
  'if mkdir -p -- "$logs" 2>/dev/null && [ -w "$logs" ]; then echo logs=ok; else echo logs=missing; fi',
  'for folder in "$@"; do if [ -d "$folder" ]; then echo "path:$folder=ok"; else echo "path:$folder=missing"; fi; done',
  // A helper that can stop runs lists "stop" in its status; older ones print nothing.
  `if out=$(sudo -n ${ROOT_SCRIPT_HELPER} status 2>/dev/null); then case "$out" in *stop*) echo rootrun=ok ;; *) echo rootrun=old ;; esac; else echo rootrun=missing; fi`,
  `if sudo -n ${ROOT_CRON_HELPER} list >/dev/null 2>&1; then echo rootcron=ok; else echo rootcron=missing; fi`,
].join("; ");
export type PreflightCheck = { id: string; label: string; status: "ok" | "warning" | "error" | "info"; detail: string };
// Checks, in one host command, everything the pages rely on, so a missing tool
// is named at setup instead of surfacing later as a broken page.
export async function preflight(): Promise<{ host: string; checks: PreflightCheck[] }> {
  const settings = serverSettings();
  const { host } = await testServerConnection();
  const output = await runAsync(["sh", "-c", PREFLIGHT_SCRIPT, "sh", settings.remoteLogs, ...settings.allowedPaths], 25000);
  const values = new Map(output.split("\n").filter((line) => line.includes("=")).map((line) => {
    const at = line.indexOf("=");
    return [line.slice(0, at), line.slice(at + 1)] as [string, string];
  }));
  const checks: PreflightCheck[] = [{ id: "ssh", label: "SSH connection", status: "ok", detail: `Connected to ${host}.` }];
  for (const [tool, level, purpose] of REQUIRED_TOOLS) {
    const found = values.get(`tool:${tool}`) === "ok";
    checks.push({ id: `tool:${tool}`, label: tool, status: found ? "ok" : level, detail: found ? "Installed." : `Not installed. ${purpose}` });
  }
  if (values.get("tool:docker") === "ok") {
    const docker = values.get("docker") || "";
    checks.push({ id: "docker", label: "Docker access", status: docker === "ok" ? "ok" : "warning", detail: docker === "ok" ? "The SSH user may use Docker." : dockerProblem(docker) });
  }
  const gnu = values.get("gnu") === "ok";
  checks.push({ id: "gnu", label: "GNU core utilities", status: gnu ? "ok" : "warning", detail: gnu ? "realpath, df and du support the options used." : "realpath -e, df -B1 or du -b is not supported (BusyBox?). Storage cards, file checks and folder sizes need GNU coreutils." });
  const logs = values.get("logs") === "ok";
  checks.push({ id: "logs", label: "Remote logs folder", status: logs ? "ok" : "warning", detail: logs ? `${settings.remoteLogs} is writable.` : `${settings.remoteLogs} cannot be created or written by the SSH user. Schedules log their runs there.` });
  for (const folder of settings.allowedPaths) {
    const found = values.get(`path:${folder}`) === "ok";
    checks.push({ id: `path:${folder}`, label: `Allowed path ${folder}`, status: found ? "ok" : "warning", detail: found ? "The folder exists." : "This folder does not exist on the server." });
  }
  const rootRun = values.get("rootrun") === "ok" || values.get("rootrun") === "old", rootCron = values.get("rootcron") === "ok";
  const outdated = values.get("rootrun") === "old" ? " The root script helper is an older version that cannot stop a running root script or enforce a time limit; run install-root-script-access.sh again to update it." : "";
  checks.push({ id: "root", label: "Root helpers", status: "info", detail: (rootRun && rootCron ? "Root scripts and root schedules are enabled." : rootRun ? "Root scripts are enabled; root schedules are not." : rootCron ? "Only the root cron helper is installed; root schedules also need the root script helper." : "Not installed. Scripts and schedules run as the SSH user.") + outdated });
  return { host, checks };
}
// Turns Docker's error into what the administrator has to do about it.
export function dockerProblem(detail: string) {
  if (/permission denied/i.test(detail)) return "The SSH user is not allowed to use Docker. Add it to the docker group and sign in again on the server.";
  if (/not found|no such file/i.test(detail) && !/docker\.sock|daemon/i.test(detail)) return "Docker is not installed on the server.";
  if (/cannot connect|daemon/i.test(detail)) return "The Docker daemon is not running on the server.";
  return detail || "Docker did not answer.";
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
// Everything the statistics need, in one host command: the server's clock and
// the monitored storage paths ($2 onwards) are read by the same script, so a
// refresh does not start a process for each of them. It runs in a plain bash,
// like every other host command, not a login one: the login profile cost time
// on every refresh, and whatever it printed or started became part of this.
const STATS_SCRIPT = [
      'read -r mem_total mem_used mem_available < <(free -b | awk \'/^Mem:/ {print $2, $3, $7}\')',
      'read -r disk_total disk_used disk_pct < <(df -B1 -P / | awk \'NR==2 {gsub(/%/, "", $5); print $2, $3, $5}\')',
      // CPU usage is the difference between two counter readings. Normally the
      // previous refresh supplies the first reading; with "sample" as $1 the
      // script takes both itself, 150 ms apart.
      'read -r _ cpu_user cpu_nice cpu_system cpu_idle cpu_iowait cpu_irq cpu_softirq cpu_steal _ < /proc/stat',
      'cpu_total=$((cpu_user + cpu_nice + cpu_system + cpu_idle + cpu_iowait + cpu_irq + cpu_softirq + cpu_steal))',
      'cpu_idle_total=$((cpu_idle + cpu_iowait))',
      'cpu_pct=',
      'if [ "$1" = sample ]; then sleep 0.15; read -r _ cpu_user cpu_nice cpu_system cpu_idle cpu_iowait cpu_irq cpu_softirq cpu_steal _ < /proc/stat; cpu_total_2=$((cpu_user + cpu_nice + cpu_system + cpu_idle + cpu_iowait + cpu_irq + cpu_softirq + cpu_steal)); cpu_idle_2=$((cpu_idle + cpu_iowait)); cpu_pct=$(awk -v total="$((cpu_total_2 - cpu_total))" -v idle="$((cpu_idle_2 - cpu_idle_total))" \'BEGIN {if (total > 0) printf "%.1f", 100 * (total - idle) / total; else print "0.0"}\'); cpu_total=$cpu_total_2; cpu_idle_total=$cpu_idle_2; fi',
      'uptime_s=$(cut -d. -f1 /proc/uptime)',
      'cores=$(nproc)',
      'temp=$(command -v sensors >/dev/null && sensors "coretemp-*" -u 2>/dev/null | awk \'/_input:/ {if ($2 > max) max=$2} END {if (max) printf "%.1f", max}\')',
      'if [ -z "$temp" ]; then temp=$(find -L /sys/class/thermal /sys/class/hwmon -mindepth 2 -maxdepth 2 -type f \\( -name temp -o -name "temp*_input" \\) -readable -exec cat {} + 2>/dev/null | awk \'$1 ~ /^[0-9]+([.][0-9]+)?$/ {v=$1; if (v > 1000) v=v/1000; if (v > 0 && v < 150 && v > max) max=v} END {if (max) printf "%.1f", max}\'); fi',
      'printf "temperatureC=%s\\nmemoryUsedBytes=%s\\nmemoryTotalBytes=%s\\nmemoryAvailableBytes=%s\\ndiskUsedBytes=%s\\ndiskTotalBytes=%s\\ndiskUsedPercent=%s\\nuptimeSeconds=%s\\ncpuUsagePercent=%s\\ncpuCores=%s\\ncpuTotal=%s\\ncpuIdle=%s\\n" "$temp" "$mem_used" "$mem_total" "$mem_available" "$disk_used" "$disk_total" "$disk_pct" "$uptime_s" "$cpu_pct" "$cores" "$cpu_total" "$cpu_idle_total"',
      'printf "time=%s\\n" "$(date "+%d.%m.%Y %H:%M:%S %Z")"',
      // One line per path, in the order given; empty where df cannot read it.
      // A path on a mount that stopped answering must not stall the refresh.
      'storage_df() { if command -v timeout >/dev/null 2>&1; then timeout 10 df -B1 -P -- "$1"; else df -B1 -P -- "$1"; fi; }',
      'shift; for storage_path in "$@"; do printf "storage=%s\\n" "$(storage_df "$storage_path" 2>/dev/null | tail -n 1)"; done',
].join("; ");
// The previous CPU counter reading, per SSH target. Readings older than this
// are not used, so a long pause does not produce a long average.
const CPU_READING_MAX_AGE_MS = 10 * 60 * 1000;
let cpuReading: { target: string; at: number; total: number; idle: number } | undefined;
async function systemStats(): Promise<{ stats: SystemStats; time: string }> {
  const target = serverSettings().sshTarget;
  const previous = cpuReading?.target === target && Date.now() - cpuReading.at < CPU_READING_MAX_AGE_MS ? cpuReading : undefined;
  const paths = monitoredPaths();
  const output = await runAsync(["bash", "-c", STATS_SCRIPT, "stats", previous ? "" : "sample", ...paths]);
  const lines = output.trim().split("\n");
  const storageLines = lines.filter((line) => line.startsWith("storage=")).map((line) => line.slice("storage=".length));
  const values = parseValues(lines.filter((line) => !line.startsWith("storage=")));
  const stats = parseStats(values, paths.map((storagePath, index) => parseStorage(storagePath, storageLines[index] ?? "")));
  const total = Number(values.cpuTotal), idle = Number(values.cpuIdle);
  if (values.cpuTotal && Number.isFinite(total) && Number.isFinite(idle)) {
    if (previous && total > previous.total) {
      const elapsed = total - previous.total;
      stats.cpuUsagePercent = Math.round(1000 * (elapsed - (idle - previous.idle)) / elapsed) / 10;
    }
    cpuReading = { target, at: Date.now(), total, idle };
  }
  return { stats, time: values.time || "" };
}
function parseValues(lines: string[]): Record<string, string> {
  return Object.fromEntries(lines.filter((line) => line.includes("=")).map((line) => {
    const at = line.indexOf("=");
    return [line.slice(0, at), line.slice(at + 1)];
  }));
}
function parseStats(values: Record<string, string>, storage: SystemStats["storage"]): SystemStats {
  const number = (key: string) => {
    const value = Number(values[key]);
    return Number.isFinite(value) ? value : 0;
  };
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
function parseStorage(storagePath: string, line: string) {
  const fields = line.trim().split(/\s+/);
  const totalBytes = Number(fields[1]);
  const usedBytes = Number(fields[2]);
  const usedPercent = Number(fields[4]?.replace("%", ""));
  return [totalBytes, usedBytes, usedPercent].every(Number.isFinite)
    ? { path: storagePath, usedBytes, totalBytes, usedPercent }
    : { path: storagePath, usedBytes: null, totalBytes: null, usedPercent: null };
}
// Share only concurrent read requests. Completed snapshots are never cached,
// so a refresh after a mutation always reads current host state.
let pendingSnapshot: ReturnType<typeof collectSnapshot> | undefined;
async function collectSnapshot() {
  // Docker may be missing or forbidden while the server itself is fine, so its
  // failure empties the container list instead of failing the whole snapshot.
  // An unreachable server still fails through the statistics below.
  const [docker, userCron, status, { stats, time }, cronLog] = await Promise.all([
    runAsync(["docker", "ps", "-a", "--format", "{{json .}}"]).then(
      (output) => ({ containers: output.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)), error: null as string | null }),
      (error) => ({ containers: [], error: dockerProblem(error instanceof Error ? error.message : "") })),
    runAsync(["crontab", "-l"]).catch(() => ""),
    rootHelperStatus(),
    systemStats(),
    readScheduleLog(),
  ]);
  return { containers: docker.containers, containerError: docker.error, cron: userCron, root: status.root, rootScript: status.rootScript, time, stats, cronLog };
}
export function hostSnapshot() {
  if (!pendingSnapshot) {
    pendingSnapshot = collectSnapshot().finally(() => { pendingSnapshot = undefined; });
  }
  return pendingSnapshot;
}
// A leading dash would be read by Docker as an option, not as a name.
export const CONTAINER_NAME = /^\w[\w.-]*$/;
// The end of a container's log. Docker passes a container's error stream on as
// its own, where applications such as Python and Go programs write their log,
// so both streams are read together. A failure is reported on the error stream
// alone, which is what the caller shows.
const CONTAINER_LOGS_SCRIPT = 'if out=$(docker logs --tail 300 --timestamps "$1" 2>&1); then printf "%s\\n" "$out"; else printf "%s\\n" "$out" >&2; exit 1; fi';
export async function containerLogs(name: string) {
  if (!CONTAINER_NAME.test(name)) throw Error("Invalid container name");
  const output = await run(["sh", "-c", CONTAINER_LOGS_SCRIPT, "sh", name]);
  return output.trim() ? output : "";
}
// Container sizes are expensive for Docker to compute, so they are only read
// when a container's details are opened.
export async function containerSize(name: string) {
  if (!CONTAINER_NAME.test(name)) throw Error("Invalid container name");
  return (await run(["docker", "ps", "-a", "--size", "--filter", `name=^/${name}$`, "--format", "{{.Size}}"])).trim();
}
// Samples metrics, evaluates alerts and records cron runs even while no browser
// is open. Started once per server process from src/instrumentation.ts.
export function startBackgroundMonitor() {
  const state = globalThis as { lscMonitor?: ReturnType<typeof setInterval> };
  if (state.lscMonitor) return;
  let running = false;
  let lastError = "";
  let lastTrim = 0;
  const tick = async () => {
    if (running || !read<{ password?: string }>("config", {}).password) return;
    running = true;
    try {
      const snapshot = await hostSnapshot();
      recordMetricSample(snapshot.stats);
      evaluateAlerts(snapshot);
      await collectCronRuns(snapshot.cronLog);
      if (Date.now() - lastTrim > 60 * 60 * 1000) {
        lastTrim = Date.now();
        await trimScheduleLog().catch(() => {});
      }
      lastError = "";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastError) console.error("Background monitor:", message);
      lastError = message;
    } finally {
      running = false;
    }
  };
  state.lscMonitor = setInterval(tick, METRIC_INTERVAL_MS);
  state.lscMonitor.unref?.();
  setTimeout(tick, 30000).unref?.();
}
