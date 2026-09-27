import assert from "node:assert/strict";
import test from "node:test";
import { loadServer } from "./harness.mjs";

function snapshotHost({ failDocker = false } = {}) {
  return (argv) => {
    if (argv[0] === "docker") return failDocker ? { code: 1, stderr: "Cannot connect to the Docker daemon" } : { stdout: '{"Names":"example"}\n' };
    if (argv[0] === "df") return { stdout: "Filesystem 1-blocks Used Available Capacity Mounted\n/dev/example 1000 200 800 20% /srv/example\n" };
    if (argv[0] === "bash") return { stdout: "cpuUsagePercent=12.5\nmemoryTotalBytes=1000\n" };
    return { stdout: "" };
  };
}

test("simultaneous snapshots share asynchronous host reads; next refresh reads again", async () => {
  const { server, commands } = loadServer({ host: snapshotHost(), delay: 5 });
  const count = (name) => commands.filter((item) => item.argv[0] === name).length;
  const first = server.hostSnapshot();
  const second = server.hostSnapshot();
  assert.equal(first, second);
  const snapshot = await first;
  assert.ok(count("docker") && count("bash") && count("date"));
  assert.equal(snapshot.stats.cpuUsagePercent, 12.5);
  assert.equal(snapshot.stats.storage[0].usedPercent, 20);
  assert.equal(count("docker"), 1);
  await server.hostSnapshot();
  assert.equal(count("docker"), 2);
});

test("failed reads do not poison later snapshots and do not leak the command line", async () => {
  const { server, commands } = loadServer({ host: snapshotHost({ failDocker: true }) });
  await assert.rejects(server.hostSnapshot(), (error) => {
    assert.equal(error.message, "Cannot connect to the Docker daemon");
    assert.ok(!error.message.includes("docker ps"));
    return true;
  });
  await assert.rejects(server.hostSnapshot(), /Docker daemon/);
  assert.equal(commands.filter((item) => item.argv[0] === "docker").length, 2);
});

// A host whose CPU counters advance between refreshes: 1,000 jiffies each time,
// of which `busy` were not idle.
function countingHost({ busy = 250 } = {}) {
  let total = 100000, idle = 90000;
  return (argv) => {
    if (argv[0] === "docker") return { stdout: '{"Names":"example"}\n' };
    if (argv[0] === "sudo") return { stdout: "" };
    if (argv[0] === "bash") {
      const sampled = argv.at(-1) === "sample";
      total += 1000; idle += 1000 - busy;
      return { stdout: `cpuUsagePercent=${sampled ? "5.0" : ""}\ncpuTotal=${total}\ncpuIdle=${idle}\n` };
    }
    return { stdout: "" };
  };
}

test("CPU usage comes from the previous refresh instead of a sampling pause", async () => {
  const { server, commands } = loadServer({ host: countingHost({ busy: 250 }) });
  const first = await server.hostSnapshot();
  assert.equal(first.stats.cpuUsagePercent, 5, "the first refresh samples on the host");
  const second = await server.hostSnapshot();
  assert.equal(second.stats.cpuUsagePercent, 25);
  const statsCalls = commands.filter((item) => item.argv[0] === "bash").map((item) => item.argv.at(-1));
  assert.deepEqual(statsCalls, ["sample", ""]);
});

test("container sizes are not computed during refreshes", async () => {
  const { server, commands } = loadServer({ host: countingHost() });
  await server.hostSnapshot();
  const docker = commands.find((item) => item.argv[0] === "docker");
  assert.ok(!docker.argv.includes("--size"));
});

test("root helper status is cached and refreshed after root's crontab changes", async () => {
  const { server, commands } = loadServer({ host: countingHost() });
  const sudoCalls = () => commands.filter((item) => item.argv[0] === "sudo").length;
  await server.hostSnapshot();
  const afterFirst = sudoCalls();
  assert.ok(afterFirst > 0);
  await server.hostSnapshot();
  assert.equal(sudoCalls(), afterFirst, "a second refresh reuses the cached status");
  server.invalidateRootStatus();
  await server.hostSnapshot();
  assert.ok(sudoCalls() > afterFirst);
});

test("the snapshot's cron log is parsed without another host read", async () => {
  const { server, commands } = loadServer();
  server.save("schedules", [{ id: "nightly", scriptId: "", expression: "0 3 * * *", label: "Nightly", enabled: true, command: "true" }]);
  const log = "MEDIA_DASHBOARD_START nightly 2026-09-27T03:00:00+03:00\nMEDIA_DASHBOARD_END nightly 2026-09-27T03:00:02+03:00 1\n";
  const runs = await server.collectCronRuns(log);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "failed");
  assert.equal(runs[0].label, "Nightly");
  assert.equal(commands.length, 0);
  assert.equal((await server.collectCronRuns(null)).length, 1, "a missing log keeps the stored runs");
});
