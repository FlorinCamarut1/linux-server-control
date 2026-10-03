// The records the dashboard stores (scripts, folders, schedules, runs, alerts)
// and their types. Reading them needs no host access.
import { read } from "./store";
export type Script = {
  id: string;
  name: string;
  path: string;
  cron: string;
  folder?: string;
  runAs?: "user" | "root";
  argumentHint?: string;
  runOptions?: RunOption[];
  // A run that takes longer is stopped and counts as failed; absent for no limit.
  timeLimitMinutes?: number;
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
// A run someone stopped is "stopped", not "failed": it needs no attention, and
// stoppedBy names the account. A run its script's time limit stopped failed,
// and has timedOut.
export type ScriptRun = {
  id: string; scriptId: string; scriptName: string; startedAt: string;
  completedAt?: string; exitCode?: number; durationMs?: number; arguments: string;
  status: "running" | "success" | "failed" | "stopped"; logPath: string;
  stoppedBy?: string; timedOut?: boolean;
};
export type AlertRule = {
  id: string; name: string; metric: "temperature" | "cpu" | "ram" | "disk" | "storage" | "failedScripts" | "stoppedContainers";
  threshold: number; enabled: boolean; cooldownMinutes: number; lastTriggeredAt?: number;
};
// storage maps each monitored path to its used percentage (absent in older samples).
export type MetricSample = { at: number; cpu: number; ram: number; temperature: number | null; disk: number; storage?: Record<string, number> };
export type CronRun = { scheduleId: string; label: string; startedAt: string; completedAt?: string; exitCode?: number; status: "running" | "success" | "failed" };
export function scriptRuns() { return read<ScriptRun[]>("script-runs", []); }
// A run as the browser sees it: without the log's location on the dashboard.
export type PublicRun = Omit<ScriptRun, "logPath">;
export function publicRun(run: ScriptRun): PublicRun {
  const shown: Partial<ScriptRun> = { ...run };
  delete shown.logPath;
  return shown as PublicRun;
}
// The latest run of every script, newest first: all that the pages other than
// History show, without sending the whole history. A script needs attention
// while its latest run is a failed one.
export function recentRuns() {
  const seen = new Set<string>();
  return scriptRuns().filter((run) => {
    const latest = !seen.has(run.scriptId);
    seen.add(run.scriptId);
    return latest;
  }).map(publicRun);
}
// The scheduled runs that still need attention, newest first: the latest
// finished run of each existing schedule, where that run failed. A failure
// followed by a successful run, or of a deleted schedule, is history.
export function failingCronRuns(runs: CronRun[], known: Schedule[]) {
  const existing = new Set(known.map((item) => item.id));
  const seen = new Set<string>();
  return runs.filter((run) => {
    if (run.status === "running" || seen.has(run.scheduleId)) return false;
    seen.add(run.scheduleId);
    return run.status === "failed" && existing.has(run.scheduleId);
  });
}
// One page of the History list: the rows whose name contains the search text
// and whose status matches, and how many there are in all.
export function historyPage<T extends { status: string }>(rows: T[], name: (row: T) => string, query: { search?: string; status?: string; offset?: number; limit?: number }) {
  const search = (query.search || "").toLowerCase();
  const status = query.status && query.status !== "all" ? query.status : "";
  const matching = rows.filter((row) => name(row).toLowerCase().includes(search) && (!status || row.status === status));
  const limit = Math.min(100, Math.max(1, Math.floor(Number(query.limit) || 20)));
  const offset = Math.max(0, Math.floor(Number(query.offset) || 0));
  return { rows: matching.slice(offset, offset + limit), total: matching.length, offset, limit };
}
export function alertRules() { return read<AlertRule[]>("alerts", []); }
export function cronRuns() { return read<CronRun[]>("cron-runs", []); }
export const RECORD_ID = /^[\w-]{1,64}$/;
export const oneLine = (value: unknown, max: number) => {
  const text = typeof value === "string" ? value.trim() : "";
  if (/[\r\n\0]/.test(text)) throw Error("Text values must be a single line");
  return text.slice(0, max);
};
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
