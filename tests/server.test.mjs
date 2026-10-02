import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadServer, plain, realHost } from "./harness.mjs";

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
  assert.ok(line.startsWith("0 3 * * * ( mkdir -p '/logs' 2>/dev/null; true 2>/dev/null >> '/logs/schedules.log' && exec >> '/logs/schedules.log' 2>&1; printf"));
  assert.ok(line.endsWith("# media-dashboard:nightly"));
  assert.ok(!/(^|[^\\])%/.test(line), "no unescaped percent sign may remain");
  assert.ok(line.includes("date +\\%F"));
  assert.throws(() => server.cronLine({ ...schedule, id: "x' ; id ; '" }, "true", "/l"), /identifier/);
  assert.throws(() => server.cronLine(schedule, "true\n* * * * * id", "/l"), /one line/);
});

// Runs a crontab line's command the way cron does: with sh, "\%" being "%".
function runCronLine(line, expression) {
  const command = line.slice(expression.length + 1).replaceAll("\\%", "%");
  return spawnSync("sh", ["-c", command], { encoding: "utf8" });
}

test("a scheduled job runs and is logged even when the log folder is missing", () => {
  const { server } = loadServer();
  const folder = path.join(mkdtempSync(path.join(tmpdir(), "lsc-cron-")), "logs");
  const log = path.join(folder, "schedules.log");
  const proof = path.join(path.dirname(folder), "ran");
  const schedule = { id: "nightly", scriptId: "", expression: "0 3 * * *", label: "", enabled: true };
  const result = runCronLine(server.cronLine(schedule, `echo 100% > '${proof}'; echo output; sh -c "exit 3"`, log), schedule.expression);
  assert.equal(result.status, 3, "the job's exit code is kept");
  assert.equal(readFileSync(proof, "utf8"), "100%\n");
  const lines = readFileSync(log, "utf8").trim().split("\n");
  assert.match(lines[0], /^MEDIA_DASHBOARD_START nightly \d{4}-/);
  assert.equal(lines[1], "output");
  assert.match(lines[2], /^MEDIA_DASHBOARD_END nightly \S+ 3$/);
  assert.equal(result.stdout, "", "the output goes to the log");
});

test("a root schedule does not create the log folder, but still runs without it", () => {
  const { server } = loadServer();
  const folder = path.join(mkdtempSync(path.join(tmpdir(), "lsc-cron-")), "logs");
  const schedule = { id: "as-root", scriptId: "", expression: "0 4 * * *", label: "", enabled: true };
  const line = server.cronLine(schedule, "echo ran", path.join(folder, "schedules-root.log"), false);
  const result = runCronLine(line, schedule.expression);
  assert.equal(result.status, 0);
  assert.ok(!existsSync(folder), "a folder owned by root would lock the SSH user out");
  assert.match(result.stdout, /MEDIA_DASHBOARD_START as-root .*\nran\nMEDIA_DASHBOARD_END as-root \S+ 0\n/s, "without a log the output goes to cron");
  assert.equal(result.stderr, "");
});

test("root and user schedules log to separate files, read together in order", async () => {
  const logs = path.join(mkdtempSync(path.join(tmpdir(), "lsc-cron-")), "logs");
  const { server } = loadServer({ host: realHost, env: { REMOTE_LOGS: logs } });
  assert.equal(server.scheduleLog("user"), path.join(logs, "schedules.log"));
  assert.equal(server.scheduleLog("root"), path.join(logs, "schedules-root.log"));
  assert.equal(await server.readScheduleLog(), null, "no log yet");
  assert.ok(existsSync(logs), "reading the logs creates their folder for root's schedules");
  writeFileSync(server.scheduleLog("user"), "MEDIA_DASHBOARD_START u 2026-09-27T03:00:00+03:00\nMEDIA_DASHBOARD_END u 2026-09-27T03:00:09+03:00 0\nMEDIA_DASHBOARD_START u 2026-09-28T03:00:00+03:00\n");
  writeFileSync(server.scheduleLog("root"), "MEDIA_DASHBOARD_START r 2026-09-27T03:00:01+03:00\nMEDIA_DASHBOARD_END r 2026-09-27T03:00:05+03:00 1\n");
  const runs = await server.collectCronRuns();
  assert.deepEqual(plain(runs.map((item) => `${item.scheduleId} ${item.status}`)), ["u running", "u success", "r failed"], "newest first across both logs");
});

test("root schedules are installed with root's log and without creating the folder", async () => {
  const cron = cronHost({ userCrontab: "" });
  const { server } = loadServer({ host: cron.host });
  server.save("scripts", [SCRIPT]);
  server.save("schedules", [
    { id: "as-root", scriptId: "backup", expression: "0 4 * * *", label: "", enabled: true, runAs: "root" },
    { id: "as-user", scriptId: "backup", expression: "0 5 * * *", label: "", enabled: true, runAs: "user" },
  ]);
  await server.syncCron();
  assert.ok(cron.crontabs.root.includes(">> '/tmp/media-dashboard/schedules-root.log'"));
  assert.ok(!cron.crontabs.root.includes("mkdir"));
  assert.ok(!cron.crontabs.root.includes("schedules.log"));
  assert.ok(cron.crontabs.user.includes("mkdir -p '/tmp/media-dashboard'"));
  assert.ok(cron.crontabs.user.includes(">> '/tmp/media-dashboard/schedules.log'"));
});

test("a large schedule log keeps its end, also when it cannot be written in place", async () => {
  const logs = mkdtempSync(path.join(tmpdir(), "lsc-cron-"));
  const { server } = loadServer({ host: realHost, env: { REMOTE_LOGS: logs } });
  const content = "old\n".repeat(1024 * 1024 * 1.5) + "MEDIA_DASHBOARD_END last 2026-09-27T03:00:05+03:00 0\n";
  writeFileSync(server.scheduleLog("user"), content);
  writeFileSync(server.scheduleLog("root"), content);
  // Like a log that root created: the SSH user may read it but not write it.
  chmodSync(server.scheduleLog("root"), 0o444);
  await server.trimScheduleLog();
  for (const user of ["user", "root"]) {
    const file = server.scheduleLog(user);
    assert.equal(statSync(file).size, 1024 * 1024, user);
    assert.ok(readFileSync(file, "utf8").endsWith(" 0\n"), user);
    assert.ok(!existsSync(file + ".trim"), user);
  }
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

test("the SSH port, key file and known hosts file are passed to ssh", async () => {
  const { server, commands } = loadServer({ env: { SSH_TARGET: "admin@server", SSH_PORT: "2222", SSH_KEY_FILE: "/run/ssh/id_rsa" } });
  await server.run(["hostname"]);
  const argv = commands[0].argv;
  assert.equal(argv[0], "ssh");
  assert.equal(argv[argv.indexOf("-p") + 1], "2222");
  assert.equal(argv[argv.indexOf("-i") + 1], "/run/ssh/id_rsa");
  assert.ok(argv.includes("UserKnownHostsFile=/run/ssh/known_hosts"), "the mounted file by default");
  const elsewhere = loadServer({ env: { SSH_TARGET: "admin@server", SSH_KNOWN_HOSTS_FILE: "/etc/dashboard/known_hosts" } });
  await elsewhere.server.run(["hostname"]);
  assert.ok(elsewhere.commands[0].argv.includes("UserKnownHostsFile=/etc/dashboard/known_hosts"));
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

test("container logs include the error stream, and a failure says why", async () => {
  // A `docker` that logs to both streams, like most applications do.
  const bin = mkdtempSync(path.join(tmpdir(), "lsc-docker-"));
  writeFileSync(path.join(bin, "docker"), `#!/bin/sh
for name; do :; done
if [ "$name" = missing ]; then echo "Error response from daemon: No such container: missing" >&2; exit 1; fi
[ "$name" = quiet ] && exit 0
echo "2026-09-27T03:00:00Z started"
echo "2026-09-27T03:00:01Z warning on the error stream" >&2
echo "2026-09-27T03:00:02Z done"
`, { mode: 0o755 });
  const host = (argv, input) => {
    const result = spawnSync(argv[0], argv.slice(1), { input: input ?? "", encoding: "utf8", env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
    return { stdout: result.stdout, stderr: result.stderr, code: result.status ?? 1 };
  };
  const { server, commands } = loadServer({ host });
  assert.equal(await server.containerLogs("app"), "2026-09-27T03:00:00Z started\n2026-09-27T03:00:01Z warning on the error stream\n2026-09-27T03:00:02Z done\n");
  assert.deepEqual(plain(commands.at(-1).argv.slice(-2)), ["sh", "app"], "the name is passed as an argument, never as part of the script");
  assert.equal(await server.containerLogs("quiet"), "", "a container that logged nothing has no log");
  await assert.rejects(server.containerLogs("missing"), /No such container: missing/);
  await assert.rejects(server.containerLogs("--follow"), /Invalid container name/);
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

test("the monitored storage paths are part of a backup", async () => {
  const cron = cronHost({ userCrontab: "" });
  const { server, readJson, fileText } = loadServer({ host: cron.host, env: { MONITORED_PATHS: "/srv/example" } });
  assert.deepEqual(plain(server.exportConfiguration().monitoredPaths), ["/srv/example"]);
  await server.restoreConfiguration(backup());
  assert.equal(fileText("monitored-paths"), null, "an older backup leaves the monitored paths alone");
  await server.restoreConfiguration(backup({ monitoredPaths: ["/mnt/media/", "/mnt/backup", "/mnt/media"] }));
  assert.deepEqual(readJson("monitored-paths"), ["/mnt/media", "/mnt/backup"]);
  assert.deepEqual(plain(server.monitoredPaths()), ["/mnt/media", "/mnt/backup"]);
  for (const invalid of [["relative/path"], ["/mnt/a\n/etc"], "/mnt/media", [42]])
    await assert.rejects(server.restoreConfiguration(backup({ monitoredPaths: invalid })), /monitored paths|single line/, JSON.stringify(invalid));
  assert.deepEqual(readJson("monitored-paths"), ["/mnt/media", "/mnt/backup"], "a rejected backup changes nothing");
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

test("a storage alert watches the fullest monitored path", () => {
  const { server, readJson } = loadServer();
  const events = [];
  server.onDashboardEvent((event) => events.push(event));
  server.save("alerts", [
    { id: "s", name: "Disks", metric: "storage", threshold: 90, cooldownMinutes: 30, enabled: true },
    { id: "d", name: "System", metric: "disk", threshold: 90, cooldownMinutes: 30, enabled: true },
  ]);
  const storage = [{ path: "/srv/a", usedPercent: 50 }, { path: "/srv/b", usedPercent: 93 }, { path: "/srv/unavailable", usedPercent: null }];
  const stats = { cpuUsagePercent: 0, memoryUsedBytes: 0, memoryTotalBytes: 0, temperatureC: null, diskUsedPercent: 40, storage };
  const result = server.evaluateAlerts({ stats, containers: [] });
  assert.equal(result.values.storage, 93);
  assert.deepEqual(plain(result.triggered.map((rule) => rule.id)), ["s"], "the system disk has its own rule");
  assert.equal(events.length, 1);
  assert.match(events[0].message, /^Storage use of \/srv\/b is 93%, at or above the threshold of 90%\.$/);
  assert.ok(readJson("alerts").find((rule) => rule.id === "s").lastTriggeredAt);
  // Within the cooldown it stays quiet; without monitored paths there is nothing to exceed.
  assert.equal(server.evaluateAlerts({ stats, containers: [] }).triggered.length, 0);
  assert.equal(server.evaluateAlerts({ stats: { ...stats, storage: [] }, containers: [] }).values.storage, 0);
  assert.equal(server.normalizeAlert({ metric: "storage", threshold: "90", cooldownMinutes: "30", enabled: "true" }).metric, "storage");
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
