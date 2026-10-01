import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadServer, plain } from "./harness.mjs";

const SCRIPT = { id: "backup", name: "Backup", path: "/srv/scripts/backup.sh", cron: "", folder: "", runAs: "user", runOptions: [] };

// A host whose crontabs live in memory. Root cron is available unless disabled.
function cronHost({ userCrontab = null, rootCron = true, readError } = {}) {
  const crontabs = { user: userCrontab, root: "" };
  const host = (argv, input) => {
    if (argv[0] === "crontab" && argv[1] === "-l") {
      if (readError) return { code: 255, stderr: readError };
      return crontabs.user === null ? { code: 1, stderr: "no crontab for media" } : { stdout: crontabs.user };
    }
    if (argv[0] === "crontab" && argv[1] === "-") { crontabs.user = input; return {}; }
    if (argv[0] === "sudo") {
      if (!rootCron) return { code: 1, stderr: "sudo: a password is required" };
      if (argv[3] === "install") { crontabs.root = input; return {}; }
      return { stdout: argv[3] === "list" ? crontabs.root : "" };
    }
    return {};
  };
  return { crontabs, host };
}

test("parseArguments handles quotes and escapes and rejects unfinished quoting", () => {
  const { server } = loadServer();
  assert.deepEqual(plain(server.parseArguments(`--name "two words" 'it''s' a\\ b`)), ["--name", "two words", "its", "a b"]);
  assert.throws(() => server.parseArguments(`"open`), /unfinished/);
  assert.throws(() => server.parseArguments("a\nb"), /single line/);
});

test("validCron requires a five-field expression", () => {
  const { server } = loadServer();
  for (const valid of ["0 3 * * *", "*/15 1-5 * * 1,3", "@reboot"]) assert.doesNotThrow(() => server.validCron(valid));
  for (const invalid of ["", "0 3 * *", "0 3 * * * *", "0 3 * * *\n* * * * * id", "0 3 * * mon"])
    assert.throws(() => server.validCron(invalid));
});

test("cronLine escapes every % and rejects unsafe identifiers", () => {
  const { server } = loadServer();
  const schedule = { id: "nightly", scriptId: "", expression: "0 3 * * *", label: "", enabled: true, command: "" };
  const line = server.cronLine(schedule, "date +%F", "/logs/schedules.log");
  assert.ok(line.startsWith("0 3 * * * ( printf"));
  assert.ok(line.endsWith("# media-dashboard:nightly"));
  assert.ok(!/(^|[^\\])%/.test(line), "no unescaped percent sign may remain");
  assert.ok(line.includes("date +\\%F"));
  assert.throws(() => server.cronLine({ ...schedule, id: "x' ; id ; '" }, "true", "/l"), /identifier/);
  assert.throws(() => server.cronLine(schedule, "true\n* * * * * id", "/l"), /one line/);
});

test("normalizeSchedule keeps root schedules restricted to approved scripts", () => {
  const { server } = loadServer();
  const base = { scriptId: "backup", expression: "0 3 * * *", runAs: "root" };
  assert.equal(server.normalizeSchedule(base, [SCRIPT], true).runAs, "root");
  assert.throws(() => server.normalizeSchedule({ ...base, command: "id" }, [SCRIPT], true), /custom root commands/);
  assert.throws(() => server.normalizeSchedule(base, [SCRIPT], false), /not been enabled/);
  assert.throws(() => server.normalizeSchedule({ ...base, scriptId: "missing" }, [SCRIPT], true), /existing script/);
  assert.equal(server.normalizeSchedule({ ...base, enabled: "false" }, [SCRIPT], true).enabled, false);
});

test("normalizeAlert treats a missing enabled flag as disabled", () => {
  const { server } = loadServer();
  const input = { metric: "cpu", threshold: "90", cooldownMinutes: "30" };
  assert.equal(server.normalizeAlert(input).enabled, false);
  assert.equal(server.normalizeAlert({ ...input, enabled: "true" }).enabled, true);
  assert.throws(() => server.normalizeAlert({ ...input, metric: "load" }), /metric/);
});

test("syncCron keeps the user's own entries and never installs after a failed read", async () => {
  const own = "# my backup\n0 1 * * * /home/media/own.sh\n";
  const ok = cronHost({ userCrontab: own });
  const { server } = loadServer({ host: ok.host });
  server.save("scripts", [SCRIPT]);
  server.save("schedules", [{ id: "nightly", scriptId: "backup", expression: "0 3 * * *", label: "Nightly", enabled: true, runAs: "user" }]);
  await server.syncCron();
  await server.syncCron();
  const lines = ok.crontabs.user.trimEnd().split("\n");
  assert.deepEqual(lines.slice(0, 2), ["# my backup", "0 1 * * * /home/media/own.sh"]);
  assert.equal(lines.length, 3, "repeated syncs must not add blank lines or duplicates");
  assert.ok(lines[2].includes("# media-dashboard:nightly"));

  const broken = cronHost({ userCrontab: own, readError: "ssh: connect to host server port 22: Connection refused" });
  const second = loadServer({ host: broken.host });
  second.server.save("scripts", [SCRIPT]);
  second.server.save("schedules", [{ id: "nightly", scriptId: "backup", expression: "0 3 * * *", label: "", enabled: true, runAs: "user" }]);
  await assert.rejects(second.server.syncCron(), /Connection refused/);
  assert.ok(!second.commands.some((item) => item.argv.join(" ") === "crontab -"), "must not install a crontab");
});

test("syncCron treats a missing crontab as empty", async () => {
  for (const stderr of ["no crontab for media", "crontab: can't open 'media': No such file or directory"]) {
    const host = cronHost();
    const { server } = loadServer({ host: (argv, input) => argv.join(" ") === "crontab -l" ? { code: 1, stderr } : host.host(argv, input) });
    server.save("scripts", [SCRIPT]);
    server.save("schedules", [{ id: "nightly", scriptId: "backup", expression: "0 3 * * *", label: "", enabled: true, runAs: "user" }]);
    await server.syncCron();
    assert.ok(host.crontabs.user.includes("# media-dashboard:nightly"), stderr);
  }
});

test("root schedules run through the root script helper", async () => {
  const cron = cronHost({ userCrontab: "" });
  const { server } = loadServer({ host: cron.host });
  server.save("scripts", [SCRIPT]);
  server.save("schedules", [
    { id: "as-root", scriptId: "backup", expression: "0 4 * * *", label: "", enabled: true, runAs: "root" },
    { id: "as-user", scriptId: "backup", expression: "0 5 * * *", label: "", enabled: true, runAs: "user" },
  ]);
  await server.syncCron();
  assert.ok(cron.crontabs.root.includes("/usr/local/sbin/media-dashboard-root-run run '/srv/scripts/backup.sh'"), "the allowlist helper runs the script");
  assert.ok(!cron.crontabs.root.includes("/bin/bash '/srv/scripts/backup.sh'"));
  assert.ok(cron.crontabs.user.includes("/bin/bash '/srv/scripts/backup.sh'"));
});

test("saving a root schedule needs both root helpers", async () => {
  // Root cron answers, the root script helper does not.
  const cron = cronHost({ userCrontab: "" });
  const host = (argv, input) => argv[0] === "sudo" && argv[2].endsWith("root-run") ? { code: 1, stderr: "sudo: a password is required" } : cron.host(argv, input);
  const { server } = loadServer({ host });
  server.save("scripts", [SCRIPT]);
  const schedule = { scriptId: "backup", expression: "0 4 * * *", runAs: "root" };
  await assert.rejects(server.saveSchedule(schedule), /both the root cron helper and the root script helper/);
  const both = loadServer({ host: cron.host });
  both.server.save("scripts", [SCRIPT]);
  await both.server.saveSchedule(schedule);
  assert.equal(both.readJson("schedules")[0].runAs, "root");
});

test("the SSH port and key file are passed to ssh", async () => {
  const { server, commands } = loadServer({ env: { SSH_TARGET: "admin@server", SSH_PORT: "2222", SSH_KEY_FILE: "/run/ssh/id_rsa" } });
  await server.run(["hostname"]);
  const argv = commands[0].argv;
  assert.equal(argv[0], "ssh");
  assert.equal(argv[argv.indexOf("-p") + 1], "2222");
  assert.equal(argv[argv.indexOf("-i") + 1], "/run/ssh/id_rsa");
  assert.equal(server.serverSettings().sshPort, 2222);
  assert.throws(() => server.updateServerSettings({ sshPort: 70000 }), /SSH port/);
  server.updateServerSettings({ sshPort: 22 });
  await server.run(["hostname"]);
  assert.equal(commands[1].argv[commands[1].argv.indexOf("-p") + 1], "22");
});

test("preflight names what is missing on the server", async () => {
  const output = [
    "tool:bash=ok", "tool:free=ok", "tool:df=ok", "tool:python3=missing", "tool:file=ok", "tool:crontab=missing", "tool:docker=ok",
    "gnu=ok", "docker=permission denied while trying to connect to the Docker daemon socket",
    "logs=ok", "path:/srv/scripts=missing", "rootrun=missing", "rootcron=missing",
  ].join("\n");
  const { server, commands } = loadServer({ env: { SSH_TARGET: "admin@server" }, host: (argv) => argv.at(-1) === "'hostname'" ? { stdout: "example\n" } : { stdout: output } });
  const result = await server.preflight();
  const status = Object.fromEntries(result.checks.map((check) => [check.id, check.status]));
  assert.equal(result.host, "example");
  assert.equal(status["tool:bash"], "ok");
  assert.equal(status["tool:python3"], "warning");
  assert.equal(status["tool:crontab"], "warning");
  assert.equal(status.docker, "warning");
  assert.match(result.checks.find((check) => check.id === "docker").detail, /docker group/);
  assert.equal(status["path:/srv/scripts"], "warning");
  assert.equal(status.root, "info");
  assert.ok(commands.at(-1).argv.at(-1).endsWith(" 'sh' '/tmp/media-dashboard' '/srv/scripts'"), "the logs folder and allowed paths are passed as arguments");
});

test("container names may not start with a dash", () => {
  const { server } = loadServer();
  for (const name of ["jellyfin", "app_1", "my.app-2"]) assert.ok(server.CONTAINER_NAME.test(name), name);
  for (const name of ["--follow", "-f", "", "a b", "a;id"]) assert.ok(!server.CONTAINER_NAME.test(name), name);
});

test("the audit log is rotated once it grows large", () => {
  const { server, data } = loadServer();
  writeFileSync(path.join(data, "audit.log"), "x".repeat(5 * 1024 * 1024 + 1));
  server.audit("after rotation");
  assert.ok(statSync(path.join(data, "audit.log.1")).size > 5 * 1024 * 1024);
  assert.match(readFileSync(path.join(data, "audit.log"), "utf8"), /after rotation\n$/);
  assert.ok(statSync(path.join(data, "audit.log")).size < 200);
});

function backup(overrides = {}) {
  return {
    version: 1,
    scripts: [SCRIPT],
    folders: [],
    schedules: [{ id: "nightly", scriptId: "backup", expression: "0 3 * * *", label: "Nightly", enabled: true, runAs: "user" }],
    alerts: [],
    serverSettings: { sshTarget: "", scriptRoot: "/srv/scripts", allowedPaths: ["/srv/scripts"], remoteLogs: "/srv/logs", metricsRetentionDays: 30 },
    ...overrides,
  };
}

test("restoreConfiguration rejects unsafe backups without changing anything", async () => {
  const hostile = [
    ["custom root command", { schedules: [{ id: "evil", command: "id > /tmp/pwned", expression: "* * * * *", runAs: "root" }] }, /custom root commands/],
    ["crontab line injection", { schedules: [{ id: "evil", scriptId: "backup", expression: "* * * * *\n* * * * * id" }] }, /cron expression/],
    ["identifier injection", { schedules: [{ id: "x' ; id ; '", scriptId: "backup", expression: "0 3 * * *" }] }, /identifier/],
    ["script outside allowed paths", { scripts: [{ ...SCRIPT, path: "/etc/cron.daily/evil.sh" }] }, /allowed location/],
    ["sibling of an allowed path", { scripts: [{ ...SCRIPT, path: "/srv/scripts-evil/x.sh" }] }, /allowed location/],
    ["path traversal", { scripts: [{ ...SCRIPT, path: "/srv/scripts/../../etc/evil.sh" }] }, /allowed location/],
    ["malformed device", { devices: { "not-a-digest": { name: "x" } } }, /devices/],
    ["invalid settings", { serverSettings: { sshTarget: "user@host; id", allowedPaths: ["/srv"] } }, /user@host/],
  ];
  for (const [name, overrides, expected] of hostile) {
    const cron = cronHost({ userCrontab: "" });
    const { server, commands, fileText } = loadServer({ host: cron.host });
    server.save("scripts", []);
    const before = fileText("scripts");
    await assert.rejects(server.restoreConfiguration(backup(overrides)), expected, name);
    assert.equal(fileText("scripts"), before, name);
    assert.equal(fileText("schedules"), null, name);
    assert.equal(fileText("server-settings"), null, name);
    assert.ok(!commands.some((item) => item.argv[0] === "crontab" || item.argv[0] === "sudo" && item.argv[3] === "install"), name);
  }
});

test("restoreConfiguration writes a valid backup and clears removed root schedules", async () => {
  const cron = cronHost({ userCrontab: "" });
  const { server, readJson } = loadServer({ host: cron.host });
  server.save("scripts", [SCRIPT]);
  server.save("schedules", [{ id: "old-root", scriptId: "backup", expression: "0 4 * * *", label: "", enabled: true, runAs: "root" }]);
  cron.crontabs.root = "0 4 * * * old # media-dashboard:old-root\n";
  await server.restoreConfiguration(backup());
  assert.deepEqual(readJson("schedules").map((item) => item.id), ["nightly"]);
  assert.ok(cron.crontabs.user.includes("# media-dashboard:nightly"));
  assert.ok(!cron.crontabs.root.includes("media-dashboard"), "the removed root schedule must leave root's crontab");
});

test("metrics are sampled at most once per interval", () => {
  const { server } = loadServer();
  const stats = { cpuUsagePercent: 10, memoryUsedBytes: 1, memoryTotalBytes: 4, temperatureC: null, diskUsedPercent: 5 };
  assert.equal(server.recordMetricSample(stats), true);
  assert.equal(server.recordMetricSample(stats), false);
  assert.equal(server.metricsSummary().count, 1);
  assert.equal(server.metricsSummary().latest.ram, 25);
});

test("failed-script alerts only count recent failures", () => {
  const { server, readJson } = loadServer();
  const old = new Date(Date.now() - 2 * server.FAILED_RUN_WINDOW_MS).toISOString();
  server.save("script-runs", [
    { id: "1", status: "failed", startedAt: old },
    { id: "2", status: "failed", startedAt: new Date().toISOString() },
  ]);
  server.save("alerts", [{ id: "a", name: "Failures", metric: "failedScripts", threshold: 2, cooldownMinutes: 1, enabled: true }]);
  const snapshot = { stats: { cpuUsagePercent: 0, memoryUsedBytes: 0, memoryTotalBytes: 0, temperatureC: null, diskUsedPercent: 0 }, containers: [] };
  const result = server.evaluateAlerts(snapshot);
  assert.equal(result.values.failedScripts, 1);
  assert.equal(result.triggered.length, 0);
  assert.equal(readJson("alerts")[0].lastTriggeredAt, undefined);
});

test("interrupted runs are marked failed on startup", () => {
  const { server, readJson } = loadServer();
  server.save("script-runs", [{ id: "1", status: "running", startedAt: new Date().toISOString(), logPath: "/nonexistent/run.log" }, { id: "2", status: "success", startedAt: new Date().toISOString() }]);
  server.recoverInterruptedRuns();
  assert.deepEqual(readJson("script-runs").map((item) => item.status), ["failed", "success"]);
});

test("metric history keeps the range and averages samples into buckets", () => {
  const { server } = loadServer();
  const now = Date.now();
  const samples = [];
  for (let minutes = 60 * 48; minutes >= 0; minutes -= 5)
    samples.push({ at: now - minutes * 60000, cpu: minutes <= 60 ? 80 : 20, ram: 50, temperature: null, disk: 10, storage: { "/mnt/media": 60 } });
  server.save("metrics", samples, false);
  const day = server.metricHistory("24h", 24, now);
  assert.ok(day.samples.length <= 24 && day.samples.length >= 23);
  assert.ok(day.samples.every((item) => item.at >= day.from), "older samples are left out");
  assert.equal(day.samples.at(-1).cpu, 80, "the last hour keeps its own average");
  assert.equal(day.samples[0].cpu, 20);
  assert.equal(day.samples[0].temperature, null, "missing values stay missing");
  assert.equal(day.samples[0].storage["/mnt/media"], 60);
});
