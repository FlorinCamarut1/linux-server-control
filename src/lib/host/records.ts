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
export type ScriptRun = {
  id: string; scriptId: string; scriptName: string; startedAt: string;
  completedAt?: string; exitCode?: number; durationMs?: number; arguments: string;
  status: "running" | "success" | "failed"; logPath: string;
};
export type AlertRule = {
  id: string; name: string; metric: "temperature" | "cpu" | "ram" | "disk" | "failedScripts" | "stoppedContainers";
  threshold: number; enabled: boolean; cooldownMinutes: number; lastTriggeredAt?: number;
};
// storage maps each monitored path to its used percentage (absent in older samples).
export type MetricSample = { at: number; cpu: number; ram: number; temperature: number | null; disk: number; storage?: Record<string, number> };
export type CronRun = { scheduleId: string; label: string; startedAt: string; completedAt?: string; exitCode?: number; status: "running" | "success" | "failed" };
export function scriptRuns() { return read<ScriptRun[]>("script-runs", []); }
// The latest run of every script and the latest failed run, newest first: all
// that the pages other than History show, without sending the whole history.
export function recentRuns() {
  const seen = new Set<string>();
  let failureFound = false;
  return scriptRuns().filter((run) => {
    const keep = !seen.has(run.scriptId) || (!failureFound && run.status === "failed");
    seen.add(run.scriptId);
    if (run.status === "failed") failureFound = true;
    return keep;
  });
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
