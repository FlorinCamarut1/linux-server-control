import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadServer, plain, realHost } from "./harness.mjs";

function snapshotHost({ dockerError = "", failStats = false } = {}) {
  return (argv) => {
    if (argv[0] === "docker") return dockerError ? { code: 1, stderr: dockerError } : { stdout: '{"Names":"example"}\n' };
    if (argv[0] === "bash") return failStats ? { code: 255, stderr: "ssh: connect to host server port 22: Connection refused" } : { stdout: "cpuUsagePercent=12.5\nmemoryTotalBytes=1000\ntime=27.09.2026 03:00:00 EEST\nstorage=/dev/example 1000 200 800 20% /srv/example\n" };
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
  assert.ok(count("docker") && count("bash"));
  assert.equal(snapshot.stats.cpuUsagePercent, 12.5);
  assert.equal(snapshot.stats.storage[0].usedPercent, 20);
  assert.equal(count("docker"), 1);
  await server.hostSnapshot();
  assert.equal(count("docker"), 2);
});

test("the clock and the storage paths are read by the statistics command", async () => {
  const stdout = "cpuUsagePercent=1.0\ntime=27.09.2026 03:00:00 EEST\nstorage=/dev/a 1000 200 800 20% /srv/a\nstorage=\nstorage=/dev/c 4000 3000 1000 75% /srv/c\n";
  const { server, commands } = loadServer({
    env: { MONITORED_PATHS: "/srv/a,/srv/missing,/srv/c" },
    host: (argv) => (argv[0] === "bash" ? { stdout } : argv[0] === "docker" ? { stdout: "" } : { stdout: "" }),
  });
  const snapshot = await server.hostSnapshot();
  assert.equal(snapshot.time, "27.09.2026 03:00:00 EEST");
  assert.deepEqual(plain(snapshot.stats.storage), [
    { path: "/srv/a", usedBytes: 200, totalBytes: 1000, usedPercent: 20 },
    { path: "/srv/missing", usedBytes: null, totalBytes: null, usedPercent: null },
    { path: "/srv/c", usedBytes: 3000, totalBytes: 4000, usedPercent: 75 },
  ]);
  const stats = commands.filter((item) => item.argv[0] === "bash");
  assert.deepEqual(stats[0].argv.slice(-3), ["/srv/a", "/srv/missing", "/srv/c"]);
  assert.ok(!commands.some((item) => item.argv[0] === "df" || item.argv[0] === "date"), "no separate process per path or for the clock");
});

test("stored records are parsed once until their file changes", () => {
  const { server, data } = loadServer();
  server.save("scripts", [{ id: "a", name: "A", path: "/srv/scripts/a.sh", cron: "" }]);
  const first = server.scripts();
  assert.equal(server.scripts(), first, "an unchanged file returns the parsed record");
  server.save("scripts", [{ id: "b", name: "B", path: "/srv/scripts/b.sh", cron: "" }]);
  assert.equal(server.scripts()[0].id, "b", "a save is seen by the next read");
  // Another writer, such as the background monitor's copy of the module.
  writeFileSync(path.join(data, "scripts.json"), JSON.stringify([{ id: "c" }, { id: "d" }]));
  assert.deepEqual(plain(server.scripts().map((item) => item.id)), ["c", "d"]);
  rmSync(path.join(data, "scripts.json"));
  assert.deepEqual(plain(server.scripts()), [], "a removed file falls back");
});

test("the recent runs are the latest run per script and the latest failure", () => {
  const { server } = loadServer();
  const run = (id, scriptId, status) => ({ id, scriptId, scriptName: scriptId, startedAt: "2026-09-27T03:00:00Z", arguments: "", status, logPath: "" });
  server.save("script-runs", [run("6", "a", "success"), run("5", "a", "success"), run("4", "b", "running"), run("3", "a", "failed"), run("2", "b", "failed"), run("1", "c", "success")]);
  assert.deepEqual(plain(server.recentRuns().map((item) => item.id)), ["6", "4", "3", "1"]);
  assert.ok(server.recentRuns().every((item) => !("logPath" in item)), "the log's location stays on the server");
});

test("the history is searched, filtered and paged on the server", () => {
  const { server } = loadServer();
  const rows = Array.from({ length: 45 }, (_, index) => ({ id: String(index), scriptName: index % 2 ? "Backup" : "Sync ports", status: index % 5 ? "success" : "failed" }));
  const name = (row) => row.scriptName;
  const first = server.historyPage(rows, name, {});
  assert.deepEqual([first.rows.length, first.total, first.offset, first.limit], [20, 45, 0, 20]);
  const last = server.historyPage(rows, name, { offset: 40 });
  assert.deepEqual(plain(last.rows.map((row) => row.id)), ["40", "41", "42", "43", "44"]);
  const found = server.historyPage(rows, name, { search: "BACK", status: "failed" });
  assert.deepEqual(plain(found.rows.map((row) => row.id)), ["5", "15", "25", "35"]);
  assert.equal(server.historyPage(rows, name, { status: "all", limit: 5000 }).rows.length, 45 > 100 ? 100 : 45);
  assert.equal(server.historyPage(rows, name, { offset: -3, limit: 0 }).rows.length, 20, "odd values fall back to the first page");
});

test("only the end of a run log is read, starting at a line", () => {
  const { server, data } = loadServer();
  const log = path.join(data, "run.log");
  assert.equal(server.readRunLogEnd(log), null, "no log yet");
  writeFileSync(log, "short log\n");
  assert.equal(server.readRunLogEnd(log), "short log\n");
  writeFileSync(log, Array.from({ length: 20000 }, (_, index) => `line ${index} ăîș`).join("\n") + "\n");
  const end = server.readRunLogEnd(log);
  const bytes = Buffer.byteLength(end);
  assert.ok(bytes <= 64 * 1024 && bytes > 63 * 1024, `${bytes} bytes`);
  assert.match(end, /^line \d+ ăîș\n/, "the view starts at a whole line");
  assert.ok(end.endsWith("line 19999 ăîș\n"));
  assert.ok(!end.includes("\ufffd"), "no character is cut in half");
});

test("failed reads do not poison later snapshots and do not leak the command line", async () => {
  const { server, commands } = loadServer({ host: snapshotHost({ failStats: true }) });
  await assert.rejects(server.hostSnapshot(), (error) => {
    assert.equal(error.message, "ssh: connect to host server port 22: Connection refused");
    assert.ok(!error.message.includes("bash -lc"));
    return true;
  });
  await assert.rejects(server.hostSnapshot(), /Connection refused/);
  assert.equal(commands.filter((item) => item.argv[0] === "bash").length, 2);
});

test("a Docker failure empties the container list instead of failing the snapshot", async () => {
  const cases = [
    ["permission denied while trying to connect to the Docker daemon socket", /docker group/],
    ["bash: line 1: docker: command not found", /not installed/],
    ["Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?", /not running/],
  ];
  for (const [dockerError, expected] of cases) {
    const { server } = loadServer({ host: snapshotHost({ dockerError }) });
    const snapshot = await server.hostSnapshot();
    assert.equal(snapshot.containers.length, 0);
    assert.match(snapshot.containerError, expected);
    assert.equal(snapshot.stats.cpuUsagePercent, 12.5, "the rest of the snapshot is still read");
  }
  const healthy = await loadServer({ host: snapshotHost() }).server.hostSnapshot();
  assert.equal(healthy.containerError, null);
});

// A host whose CPU counters advance between refreshes: 1,000 jiffies each time,
// of which `busy` were not idle.
function countingHost({ busy = 250 } = {}) {
  let total = 100000, idle = 90000;
  return (argv) => {
    if (argv[0] === "docker") return { stdout: '{"Names":"example"}\n' };
    if (argv[0] === "sudo") return { stdout: "" };
    if (argv[0] === "bash") {
      const sampled = argv.includes("sample");
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
  const statsCalls = commands.filter((item) => item.argv[0] === "bash").map((item) => item.argv.includes("sample"));
  assert.deepEqual(statsCalls, [true, false]);
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

test("only the schedule markers are read from the schedule log", async () => {
  const { server, commands } = loadServer({ host: realHost, env: { REMOTE_LOGS: mkdtempSync(path.join(tmpdir(), "lsc-logs-")) } });
  assert.equal(await server.readScheduleLog(), null, "no log yet");
  const log = path.join(server.serverSettings().remoteLogs, "schedules.log");
  writeFileSync(log, "job output\n");
  assert.deepEqual(plain(await server.collectCronRuns()), [], "a log without markers has no runs");
  writeFileSync(log, "MEDIA_DASHBOARD_START nightly 2026-09-27T03:00:00+03:00\n" + "noisy output\n".repeat(5000) + "MEDIA_DASHBOARD_END nightly 2026-09-27T03:00:02+03:00 0\n");
  const output = await server.readScheduleLog();
  assert.ok(!output.includes("noisy"), "job output stays on the server");
  const runs = await server.collectCronRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "success");
  assert.equal(commands.at(-1).argv[0], "sh");
});

test("audited actions name the account that performed them", () => {
  const { server, data } = loadServer();
  server.asActor("maria", () => server.audit("schedule saved nightly"));
  server.audit("alert triggered Disk: 91");
  const lines = readFileSync(path.join(data, "audit.log"), "utf8").trim().split("\n");
  assert.match(lines[0], /^\S+ \[maria\] schedule saved nightly$/);
  assert.match(lines[1], /^\S+ alert triggered Disk: 91$/);
});
