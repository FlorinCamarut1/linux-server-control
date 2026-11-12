import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadRoutes, loadServer, plain } from "./harness.mjs";

// What `udisksctl dump` printed on a real server (serial numbers and IDs
// replaced): a SATA SSD, an NVMe SSD, a DVD drive, a partition and a loop device.
const DUMP = readFileSync(new URL("./fixtures/udisks-dump.txt", import.meta.url), "utf8");
// The same server with its SATA disk's SMART values changed.
const SATA_DRIVE = DUMP.indexOf("/org/freedesktop/UDisks2/drives/SD_Ultra");
const changed = (values) => DUMP.slice(0, SATA_DRIVE) + DUMP.slice(SATA_DRIVE).replace(/( {4}Smart(\w+):\s*)(.*)/g, (line, start, name) => (name in values ? start + values[name] : line));
const udisks = (output) => (argv) => argv[3] === "disks" ? (typeof output === "function" ? output() : output) : { stdout: "" };

test("udisks' SMART data becomes one entry per disk that has it", () => {
  const { server } = loadServer();
  const disks = plain(server.disksFromDump(DUMP));
  assert.deepEqual(disks.map((disk) => disk.device), ["/dev/nvme0n1", "/dev/sda"], "the DVD drive and the loop device have none");
  const [nvme, ssd] = disks;
  assert.equal(nvme.model, "INTEL SSDPEKKF256G8L");
  assert.equal(nvme.kind, "nvme");
  assert.equal(nvme.status, "ok");
  assert.equal(nvme.temperatureC, 53, "326 K");
  assert.equal(nvme.powerOnHours, 18470);
  assert.equal(ssd.model, "SD Ultra 3D 4TB");
  assert.equal(ssd.kind, "ata");
  assert.equal(ssd.rotational, false);
  assert.equal(ssd.sizeBytes, 4000787030016);
  assert.equal(ssd.temperatureC, 19, "292.15 K");
  assert.equal(ssd.powerOnHours, 3323, "from seconds");
  assert.equal(ssd.updatedAt, 1794498608000);
  assert.deepEqual(ssd.problems, []);
});

test("SMART problems make a disk need attention, and a failing disk fail", () => {
  const { server } = loadServer();
  const ssd = (values) => plain(server.disksFromDump(changed(values))).find((disk) => disk.device === "/dev/sda");
  const sectors = ssd({ NumBadSectors: "8" });
  assert.equal(sectors.status, "attention");
  assert.equal(server.describeProblem(sectors.problems[0]), "8 bad sectors");
  assert.equal(server.describeProblem({ text: "sectors", count: 1 }), "1 bad sector");
  assert.equal(ssd({ SelftestStatus: "error_read" }).status, "attention");
  assert.equal(ssd({ SelftestStatus: "aborted" }).status, "ok", "an interrupted self-test found nothing");
  const failing = ssd({ Failing: "true", NumAttributesFailing: "2" });
  assert.equal(failing.status, "failing");
  assert.deepEqual(failing.problems.map(server.describeProblem), ["The disk reports that it is about to fail", "2 SMART attributes below their threshold"]);
  assert.equal(ssd({ Updated: "0" }).status, "unknown", "SMART data not read yet");
  assert.equal(ssd({ Temperature: "0.0" }).temperatureC, null);
});

test("NVMe critical warnings are read by their kind", () => {
  const { server } = loadServer();
  const nvme = (warnings) => plain(server.disksFromDump(DUMP.replace(/(SmartCriticalWarning:\s*)$/m, `$1${warnings}`))).find((disk) => disk.kind === "nvme");
  assert.equal(nvme("spare").status, "attention");
  assert.equal(nvme("['spare', 'temperature']").problems.length, 2);
  const readOnly = nvme("['temperature', 'readonly']");
  assert.equal(readOnly.status, "failing");
  assert.equal(server.describeProblem(readOnly.problems[0]), "It has become read-only", "the failure comes first");
});

test("the disks are read once for a while, and a server without udisks says so", async () => {
  let output = { stdout: DUMP };
  const { server, commands } = loadServer({ host: udisks(() => output) });
  const first = plain(await server.diskHealth());
  assert.equal(first.available, true);
  assert.equal(first.disks.length, 2);
  await server.diskHealth();
  assert.equal(commands.length, 1, "a recent reading is used again");
  await server.diskHealth(true);
  assert.equal(commands.length, 2, "Check now reads the server");
  assert.equal(server.hottestDisk(), 53);
  output = { code: 127, stderr: "udisksctl: not found" };
  assert.deepEqual(plain(await server.diskHealth(true)), { ...plain(await server.diskHealth()), available: false, reason: "missing", disks: [] });
  assert.equal(server.hottestDisk(), 0);
  output = { code: 1, stderr: "Error connecting to the udisks daemon: Could not connect" };
  const failed = plain(await server.diskHealth(true));
  assert.equal(failed.reason, "failed");
  assert.match(failed.error, /udisks daemon/);
});

test("a disk that starts to report a problem is announced once, and so is its recovery", async () => {
  let output = { stdout: DUMP };
  const { server, readJson } = loadServer({ host: udisks(() => output) });
  const events = [];
  server.onDashboardEvent((event) => events.push(event));
  await server.checkDisks();
  assert.equal(events.length, 0, "healthy disks are not announced");
  output = { stdout: changed({ NumBadSectors: "3" }) };
  await server.checkDisks();
  await server.checkDisks();
  assert.equal(events.length, 1, "the same problem is announced once");
  assert.equal(events[0].type, "disk-health");
  assert.equal(events[0].severity, "warning");
  assert.equal(events[0].title, "Disk problem: SD Ultra 3D 4TB (/dev/sda)");
  assert.equal(events[0].message, "3 bad sectors.");
  output = { stdout: changed({ NumBadSectors: "3", Failing: "true" }) };
  await server.checkDisks();
  assert.equal(events.length, 2, "a worse state is announced");
  assert.equal(events[1].severity, "critical");
  // What each disk reported is kept, so a restart does not announce it again.
  const restarted = loadServer({ host: udisks(() => output) });
  restarted.server.save("disk-health", readJson("disk-health"));
  const later = [];
  restarted.server.onDashboardEvent((event) => later.push(event));
  await restarted.server.checkDisks();
  assert.equal(later.length, 0);
  output = { stdout: DUMP };
  await server.checkDisks();
  assert.equal(events.length, 3);
  assert.equal(events[2].severity, "success");
  assert.equal(events[2].title, "Disk healthy again: SD Ultra 3D 4TB (/dev/sda)");
});

test("a disk first seen with a problem is announced", async () => {
  const { server } = loadServer({ host: udisks({ stdout: changed({ NumAttributesFailing: "1" }) }) });
  const events = [];
  server.onDashboardEvent((event) => events.push(event));
  await server.checkDisks();
  assert.equal(events.length, 1);
  assert.equal(events[0].message, "1 SMART attribute below its threshold.");
});

test("the hottest disk can trigger an alert rule", async () => {
  const { server } = loadServer({ host: udisks({ stdout: DUMP }) });
  server.saveAlert({ name: "Hot disk", metric: "diskTemperature", threshold: "50", cooldownMinutes: "60", enabled: "true" });
  await server.diskHealth(true);
  const stats = { cpuUsagePercent: 1, memoryUsedBytes: 1, memoryTotalBytes: 10, diskUsedPercent: 1, temperatureC: 40, storage: [] };
  const { values, triggered } = server.evaluateAlerts({ stats, containers: [] });
  assert.equal(values.diskTemperature, 53);
  assert.equal(triggered.length, 1);
});

test("GET disks sends the problems in words, also to a read-only account", async () => {
  const { server } = loadServer({ host: udisks({ stdout: changed({ NumBadSectors: "2" }) }) });
  const { routes } = loadRoutes(server);
  const context = { req: { nextUrl: new URL("http://dashboard/api/disks?fresh=true") }, body: {}, sid: "s", session: { device: "d" }, devices: {}, user: { name: "viewer", role: "viewer" } };
  const answer = plain(await (await routes["GET disks"](context)).json());
  assert.deepEqual(answer.disks.find((disk) => disk.device === "/dev/sda").problems, ["2 bad sectors"]);
});
