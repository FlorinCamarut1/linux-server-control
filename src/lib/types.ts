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
  Size: string;
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
export type St = {
  containers: C[];
  scripts: S[];
  schedules: Schedule[];
  folders: string[];
  cron: string;
  devices: Record<string, { name: string; created: string }>;
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
  runs: { id: string; scriptId: string; scriptName: string; startedAt: string; completedAt?: string; exitCode?: number; durationMs?: number; arguments: string; status: "running" | "success" | "failed" }[];
  alerts: { id: string; name: string; metric: string; threshold: number; enabled: boolean; cooldownMinutes: number; lastTriggeredAt?: number }[];
  metrics?: { latest: { at: number; cpu: number; ram: number; temperature: number | null; disk: number } | null; count: number; intervalMinutes: number };
  cronRuns: { scheduleId: string; label: string; startedAt: string; completedAt?: string; exitCode?: number; status: "running" | "success" | "failed" }[];
  monitoredPaths: string[];
};
export type ScriptBrowserData = {
  path: string;
  parent: string | null;
  roots: string[];
  entries: { name: string; path: string; type: "directory" | "script" }[];
};
export type FileBrowserData = {
  path: string;
  parent: string | null;
  roots: string[];
  entries: { name: string; path: string; type: "directory" | "file"; size: number | null }[];
};
