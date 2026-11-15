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
// input: the prompt for a value typed when running, which takes the place of
// "{value}" in the arguments or follows them.
export type RunOption = { label: string; value: string; description: string; needsFile?: boolean; input?: string };
// The run conditions are set here rather than in the script: time limit,
// variables (runs as the SSH user), one run at a time, a question before each
// run, and an announcement of successful runs.
export type S = {
  id: string; name: string; path: string; cron: string; folder?: string; runAs?: "user" | "root"; argumentHint?: string; runOptions?: RunOption[];
  timeLimitMinutes?: number; variables?: Record<string, string>; singleRun?: boolean; confirmRun?: boolean; notifySuccess?: boolean;
};
export type Schedule = {
  id: string;
  scriptId: string;
  expression: string;
  label: string;
  enabled: boolean;
  runAs?: "user" | "root";
  command?: string;
  // The script's arguments for this schedule, such as one of its run options.
  arguments?: string;
};
export type User = { name: string; role: "admin" | "viewer" };
// name: what the schedule runs, its script or command, as History lists it.
export type CronRun = { scheduleId: string; label: string; name?: string; startedAt: string; completedAt?: string; exitCode?: number; status: "running" | "success" | "failed" };
// "stopped" when an account stopped the run (stoppedBy); a run its time limit
// stopped is "failed" with timedOut.
export type Run = { id: string; scriptId: string; scriptName: string; startedAt: string; completedAt?: string; exitCode?: number; durationMs?: number; arguments: string; status: "running" | "success" | "failed" | "stopped"; stoppedBy?: string; timedOut?: boolean };
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
  // stop: the root script helper can stop the root runs it starts.
  rootScript: { available: boolean; stop?: boolean };
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
    swapUsedBytes: number;
    swapTotalBytes: number;
    // The load averages of the last 1, 5 and 15 minutes.
    load1: number;
    load5: number;
    load15: number;
    // Network traffic since the refresh before; null until two were read.
    netRxBytesPerSecond: number | null;
    netTxBytesPerSecond: number | null;
  };
  // The latest run of each script; the History page loads the run history
  // itself, a page at a time.
  recentRuns: Run[];
  // forMinutes: how long the value must stay at or above the threshold before
  // the rule announces it; aboveSince: since when it has.
  alerts: { id: string; name: string; metric: string; threshold: number; enabled: boolean; cooldownMinutes: number; lastTriggeredAt?: number; forMinutes?: number; aboveSince?: number }[];
  // The rules that wait before they announce their value, and still do.
  alertsWaiting?: string[];
  // The value each alert metric had at the last full refresh.
  alertState?: { values: Record<string, number> };
  // When the snapshot shown was read, if it is one the dashboard kept rather
  // than the server as it is now.
  keptAt?: number;
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
  // modified: when the entry last changed, in seconds since 1970. stale: a
  // folder's size was measured a while ago, and it is being measured again.
  entries: { name: string; path: string; type: "directory" | "file"; size: number | null; modified?: number; stale?: boolean }[];
  // Whether hidden files are listed, and whether they were asked for.
  hidden?: boolean;
  hiddenRequested?: boolean;
};
// A disk's SMART health, as GET disks sends it: its problems already in words.
export type Disk = {
  id: string; device: string; model: string; serial: string; sizeBytes: number; kind: "ata" | "nvme"; rotational: boolean;
  status: "ok" | "attention" | "failing" | "unknown"; temperatureC: number | null; powerOnHours: number | null; problems: string[]; updatedAt: number | null;
};
export type DiskReport = { available: boolean; reason?: "missing" | "failed"; error?: string; disks: Disk[]; at: number };
// What the server waits for, as GET system sends it: null where it is not known.
export type SystemReport = {
  os: string; kernel: string; manager: string; updates: number | null; security: number | null;
  restartNeeded: boolean | null; failedUnits: string[] | null; at: number;
};
// cpuPercent: its share of what all the cores have.
export type Process = { pid: number; name: string; cpuPercent: number; memoryBytes: number };
export type ContainerUse = { cpuPercent: number | null; memory: string; memoryPercent: number | null };
export type PreflightCheck = { id: string; label: string; status: "ok" | "warning" | "error" | "info"; detail: string };
