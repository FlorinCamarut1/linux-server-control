// The disks of the demo server: an SSD in good health and an older disk with
// a few bad sectors.
export const demoDisks = () => ({
  available: true, at: Date.now(),
  disks: [
    { id: "demo-nvme", device: "/dev/nvme0n1", model: "Example NVMe SSD 1TB", serial: "DEMO0001", sizeBytes: 1000204886016, kind: "nvme" as const, rotational: false, status: "ok" as const, temperatureC: 41, powerOnHours: 9120, problems: [], updatedAt: Date.now() - 4 * 60000 },
    { id: "demo-hdd", device: "/dev/sda", model: "Example HDD 8TB", serial: "DEMO0002", sizeBytes: 8001563222016, kind: "ata" as const, rotational: true, status: "attention" as const, temperatureC: 36, powerOnHours: 31800, problems: [{ text: "sectors", count: 8 }], updatedAt: Date.now() - 4 * 60000 },
  ],
});
// What the demo server waits for, and what it is busy with.
export const demoSystem = () => ({ os: "Ubuntu 24.04.3 LTS", kernel: "6.8.0-60-generic", manager: "apt", updates: 14, security: 3, restartNeeded: true, failedUnits: [], at: Date.now() });
export const demoProcesses = () => ({
  at: Date.now(),
  processes: [
    { pid: 2114, name: "ffmpeg", cpuPercent: 11.2, memoryBytes: 412 * 1048576 },
    { pid: 1780, name: "jellyfin", cpuPercent: 3.4, memoryBytes: 1310 * 1048576 },
    { pid: 1422, name: "dockerd", cpuPercent: 0.9, memoryBytes: 160 * 1048576 },
    { pid: 2301, name: "Sonarr", cpuPercent: 0.4, memoryBytes: 520 * 1048576 },
  ],
});
// Returned by the development-only demo login instead of reading a real host.
export const demoState = {
  host: "demo@media-server",
  time: "08.09.2026 14:32 EEST",
  scripts: [
    { id: "backup", name: "Media backup", path: "/home/media/backup.sh", cron: "" },
    { id: "sync", name: "Sync VPN port", path: "/home/media/sync-port.sh", cron: "" },
  ],
  folders: ["Backups", "Networking"],
  schedules: [
    { id: "morning", scriptId: "backup", expression: "0 3 * * *", label: "Every day at 03:00", enabled: true, runAs: "user" },
  ],
  cron: "0 3 * * * /home/media/backup.sh",
  devices: {
    demo: { name: "Personal laptop", created: "08.09.2026, 14:00" },
  },
  device: "demo",
  recentRuns: [],
  alerts: [],
  cronFailures: [],
  monitoredPaths: ["/mnt/storage"],
  metrics: { latest: null, count: 0, intervalMinutes: 5 },
  root: { available: false, cron: "", system: "" },
  rootScript: { available: false },
  stats: {
    temperatureC: 46.2,
    memoryUsedBytes: 6940667904,
    memoryTotalBytes: 16777216000,
    memoryAvailableBytes: 9835475100,
    diskUsedBytes: 128849018880,
    diskTotalBytes: 499289948160,
    diskUsedPercent: 26,
    storage: [
      {
        path: "/mnt/storage",
        usedBytes: 1649267441664,
        totalBytes: 3999688294400,
        usedPercent: 41,
      },
    ],
    uptimeSeconds: 196560,
    cpuUsagePercent: 18.4,
    cpuCores: 8,
    swapUsedBytes: 268435456,
    swapTotalBytes: 4294967296,
    load1: 1.42,
    load5: 1.1,
    load15: 0.86,
    netRxBytes: null,
    netTxBytes: null,
    netRxBytesPerSecond: 1843200,
    netTxBytesPerSecond: 412000,
  },
  containers: [
    {
      ID: "a91b2c3d4e5f",
      Names: "jellyfin",
      Image: "lscr.io/linuxserver/jellyfin:latest",
      State: "running",
      Status: "Up 6 hours (healthy)",
      Ports: "0.0.0.0:8096->8096/tcp",
      CreatedAt: "2026-09-08 08:12:04 +0300 EEST",
      Networks: "media",
      Mounts: "/mnt/storage,/config",
      Size: "1.2GB",
      Labels: "com.docker.compose.project=media,com.docker.compose.service=jellyfin",
    },
    {
      ID: "b82c3d4e5f6a",
      Names: "sonarr",
      Image: "lscr.io/linuxserver/sonarr:latest",
      State: "running",
      Status: "Up 6 hours",
      Ports: "8989/tcp",
      CreatedAt: "2026-09-08 08:12:10 +0300 EEST",
      Networks: "media",
      Mounts: "/mnt/storage,/config",
      Size: "428MB",
      Labels: "com.docker.compose.project=media,com.docker.compose.service=sonarr",
    },
    {
      ID: "c73d4e5f6a7b",
      Names: "transmission",
      Image: "lscr.io/linuxserver/transmission:latest",
      State: "exited",
      Status: "Exited (0) 2 hours ago",
      Ports: "",
      CreatedAt: "2026-09-07 18:30:00 +0300 EEST",
      Networks: "media",
      Mounts: "/downloads,/config",
      Size: "312MB",
    },
  ],
};
