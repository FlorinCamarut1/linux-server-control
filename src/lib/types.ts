export type C = {
  ID: string;
  Names: string;
  Image: string;
  State: string;
  Status: string;
  Ports: string;
  CreatedAt: string;
  Networks: string;
  Mounts: string;
  Size?: string;
  Labels?: string;
};
export type RunOption = { label: string; value: string; description: string; needsFile?: boolean };
export type S = { id: string; name: string; path: string; cron: string; folder?: string; runAs?: "user" | "root"; argumentHint?: string; runOptions?: RunOption[] };
export type Schedule = {
  id: string;
  scriptId: string;
  expression: string;
  label: string;
  enabled: boolean;
  runAs?: "user" | "root";
  command?: string;
};
export type User = { name: string; role: "admin" | "viewer" };
export type CronRun = { scheduleId: string; label: string; startedAt: string; completedAt?: string; exitCode?: number; status: "running" | "success" | "failed" };
export type Run = { id: string; scriptId: string; scriptName: string; startedAt: string; completedAt?: string; exitCode?: number; durationMs?: number; arguments: string; status: "running" | "success" | "failed" };
export type St = {
  user?: User;
  containers: C[];
  // Set when Docker could not be read while the server itself answered.
  containerError?: string | null;
  scripts: S[];
  schedules: Schedule[];
  folders: string[];
  cron: string;
  devices: Record<string, { name: string; created: string }>;
  // The key in `devices` of the browser this page runs in.
  device?: string;
  host: string;
  time: string;
  root: { available: boolean; cron: string; system: string };
  rootScript: { available: boolean };
  stats: {
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
  // The latest run of each script; the History page loads the run history
  // itself, a page at a time.
  recentRuns: Run[];
  alerts: { id: string; name: string; metric: string; threshold: number; enabled: boolean; cooldownMinutes: number; lastTriggeredAt?: number }[];
  // The value each alert metric had at the last full refresh.
  alertState?: { values: Record<string, number> };
  metrics?: { latest: { at: number; cpu: number; ram: number; temperature: number | null; disk: number } | null; count: number; intervalMinutes: number };
  // Schedules whose latest finished run failed, newest first.
  cronFailures?: CronRun[];
  monitoredPaths: string[];
};
export type ScriptBrowserData = {
  path: string;
  parent: string | null;
  roots: string[];
  entries: { name: string; path: string; type: "directory" | "script" }[];
  total?: number;
};
export type FileBrowserData = {
  path: string;
  parent: string | null;
  roots: string[];
  total?: number;
  entries: { name: string; path: string; type: "directory" | "file"; size: number | null }[];
};
export type PreflightCheck = { id: string; label: string; status: "ok" | "warning" | "error" | "info"; detail: string };
