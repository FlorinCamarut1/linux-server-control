import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadServer, plain } from "./harness.mjs";

// The conditions of a script's runs, set in the dashboard: run options without
// arguments or with a typed value, variables, schedules that pick an option,
// the time limit on scheduled runs, announcements, and alerts that end.

test("run options may have no arguments or ask for a value", () => {
  const { server } = loadServer();
  const options = plain(server.parseRunOptions([
    { label: "Send the report", value: "" },
    { label: "Preview", value: "--test", description: "Sends nothing" },
    { label: "A month", value: "--luna {value}", input: "Month (YYYY-MM)" },
  ]));
  assert.deepEqual(options.map((option) => [option.value, option.input ?? null]), [["", null], ["--test", null], ["--luna {value}", "Month (YYYY-MM)"]]);
  assert.throws(() => server.parseRunOptions([{ label: "", value: "--x" }]), /needs a name/);
  assert.throws(() => server.parseRunOptions([{ label: "Broken", value: "--name 'open" }]), /closed quotes/);
});

test("a typed value takes the place of {value}, or follows the arguments", async () => {
  const { server } = loadServer();
  const run = async (...args) => plain(await server.runArguments(...args));
  assert.deepEqual(await run("--luna {value} --yes", "", "2026-06"), { args: ["--luna", "2026-06", "--yes"], shown: "--luna 2026-06 --yes" });
  assert.deepEqual(await run("--luna", "", "2026-06"), { args: ["--luna", "2026-06"], shown: "--luna 2026-06" });
  assert.deepEqual(await run("", "", ""), { args: [], shown: "" });
  await assert.rejects(server.runArguments("--x {value}", "", "two\nlines"), /one line/);
});

test("variables are NAME=value lines, without the names that change the shell", () => {
  const { server } = loadServer();
  assert.deepEqual(plain(server.parseVariables("# kept for 30 days\nKEEP_SNAPSHOTS=3\n\nBACKUP_DIR=/mnt/storage/backups\nGREETING=hello world=yes\n")),
    { KEEP_SNAPSHOTS: "3", BACKUP_DIR: "/mnt/storage/backups", GREETING: "hello world=yes" });
  assert.deepEqual(plain(server.parseVariables({ A: "1" })), { A: "1" });
  assert.equal(server.parseVariables(""), undefined);
  for (const reserved of ["PATH=/tmp", "LD_PRELOAD=/tmp/x.so", "BASH_ENV=/tmp/x", "IFS=x", "BASH_FUNC_x%%=() { id; }"])
    assert.throws(() => server.parseVariables(reserved), /cannot be set|NAME=value/, reserved);
  assert.throws(() => server.parseVariables("1ABC=x"), /NAME=value/);
  assert.throws(() => server.parseVariables("NOVALUE"), /NAME=value/);
  assert.throws(() => server.parseVariables(`LONG=${"x".repeat(1001)}`), /1,000/);
});

// A server whose files exist and whose root helper answers with `status`.
function scriptHost({ helper = "stop\n" } = {}) {
  return (argv) => {
    if (argv[0] === "sudo") return { stdout: helper };
    const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
    return { stdout: result.stdout, stderr: result.stderr, code: result.status };
  };
}
test("a script keeps its run conditions; a root script takes no variables", async () => {
  const folder = mkdtempSync(path.join(tmpdir(), "lsc-conditions-"));
  const script = path.join(folder, "task.sh");
  writeFileSync(script, "echo task\n");
  const { server, readJson } = loadServer({ host: scriptHost(), env: { ALLOWED_PATHS: folder, SCRIPT_ROOT: folder } });
  await server.addScript({ name: "Task", path: script, runAs: "user", runOptions: "[]", variables: "KEEP=3", singleRun: "true", confirmRun: "true", notifySuccess: "true", timeLimitMinutes: "15" });
  const saved = readJson("scripts")[0];
  assert.deepEqual([saved.variables, saved.singleRun, saved.confirmRun, saved.notifySuccess, saved.timeLimitMinutes], [{ KEEP: "3" }, true, true, true, 15]);
  // Unchecked boxes are left out of a form, so they turn the conditions off.
  await server.addScript({ id: saved.id, name: "Task", path: script, runAs: "user", runOptions: "[]" });
  assert.deepEqual(Object.keys(readJson("scripts")[0]).sort(), ["cron", "folder", "id", "name", "path", "runAs", "runOptions"]);
  await assert.rejects(server.addScript({ name: "Root task", path: script, runAs: "root", runOptions: "[]", variables: "KEEP=3" }), /arguments only/);
});

test("a schedule runs its script with the script's conditions and the chosen arguments", () => {
  const { server } = loadServer();
  const script = { id: "backup", name: "Backup", path: "/srv/scripts/backup.sh", cron: "", runAs: "user", timeLimitMinutes: 30, variables: { KEEP: "3", NOTE: "50% off" } };
  const schedule = server.normalizeSchedule({ scriptId: "backup", expression: "0 3 * * *", label: "Nightly", arguments: "--latest --yes" }, [script], false);
  assert.equal(schedule.arguments, "--latest --yes");
  assert.equal(server.scheduleCommand(schedule, script, "user"), "timeout -k 10s 30m env 'KEEP=3' 'NOTE=50% off' /bin/bash '/srv/scripts/backup.sh' '--latest' '--yes'");
  // Root runs through the helper, with arguments but without variables.
  assert.equal(server.scheduleCommand(schedule, script, "root"), "timeout -k 10s 30m /usr/local/sbin/media-dashboard-root-run run '/srv/scripts/backup.sh' '--latest' '--yes'");
  assert.equal(server.scheduleCommand({ ...schedule, arguments: undefined }, { ...script, timeLimitMinutes: undefined, variables: undefined }, "user"), "/bin/bash '/srv/scripts/backup.sh'");
  // A custom command carries its own arguments.
  const command = server.normalizeSchedule({ command: "date", expression: "@reboot", arguments: "--ignored" }, [script], false);
  assert.equal(command.arguments, undefined);
  assert.throws(() => server.normalizeSchedule({ scriptId: "backup", expression: "0 3 * * *", arguments: "'open" }, [script], false), /unfinished/);
});

test("a scheduled run gets the variables and arguments, and its time limit ends it", () => {
  const { server } = loadServer();
  const folder = mkdtempSync(path.join(tmpdir(), "lsc-scheduled-"));
  const scriptPath = path.join(folder, "show.sh");
  writeFileSync(scriptPath, 'echo "keep=$KEEP note=$NOTE args=$*"\n[ "$1" != slow ] || sleep 120\n');
  const log = path.join(folder, "schedules.log");
  const runLine = (args, limit) => {
    const script = { id: "show", name: "Show", path: scriptPath, cron: "", runAs: "user", variables: { KEEP: "3", NOTE: "100% sure" }, ...(limit ? { timeLimitMinutes: limit } : {}) };
    const schedule = server.normalizeSchedule({ id: "s1", scriptId: "show", expression: "* * * * *", arguments: args }, [script], false);
    const line = server.cronLine(schedule, server.scheduleCommand(schedule, script, "user"), log);
    // As cron runs it: with sh, "\%" being "%".
    return spawnSync("sh", ["-c", line.slice("* * * * * ".length).replaceAll("\\%", "%")], { encoding: "utf8" });
  };
  assert.equal(runLine("--latest 'two words'").status, 0);
  assert.match(readFileSync(log, "utf8"), /^keep=3 note=100% sure args=--latest two words$/m);
  // timeout(1) takes minutes; a tenth of one ends this run after 6 seconds.
  const started = Date.now();
  const slow = runLine("slow", 0.1);
  assert.equal(slow.status, 124);
  assert.ok(Date.now() - started < 30000);
  assert.match(readFileSync(log, "utf8"), /MEDIA_DASHBOARD_END s1 \S+ 124$/m);
});

test("scheduled runs announce failures once ended, and successes when their script asks", async () => {
  const { server } = loadServer();
  const events = [];
  server.onDashboardEvent((event) => events.push(event));
  server.save("scripts", [
    { id: "quiet", name: "Quiet", path: "/srv/scripts/quiet.sh", cron: "", timeLimitMinutes: 20 },
    { id: "loud", name: "Loud", path: "/srv/scripts/loud.sh", cron: "", notifySuccess: true },
  ]);
  server.save("schedules", [
    { id: "q", scriptId: "quiet", expression: "0 * * * *", label: "Quiet hourly", enabled: true },
    { id: "l", scriptId: "loud", expression: "0 * * * *", label: "Loud hourly", enabled: true },
  ]);
  const start = (id, at) => `MEDIA_DASHBOARD_START ${id} 2026-10-03T0${at}:00:00+03:00`;
  const end = (id, at, code) => `MEDIA_DASHBOARD_END ${id} 2026-10-03T0${at}:05:00+03:00 ${code}`;
  await server.collectCronRuns(["", start("q", 1), end("q", 1, 0)].join("\n"));
  assert.deepEqual(events, [], "the first collection only learns what happened");
  // Seen while still going, then ended past the time limit: announced once.
  await server.collectCronRuns(["", start("q", 1), end("q", 1, 0), start("q", 2), start("l", 2)].join("\n"));
  assert.deepEqual(events, []);
  const ended = ["", start("q", 1), end("q", 1, 0), start("q", 2), end("q", 2, 124), start("l", 2), end("l", 2, 0)].join("\n");
  await server.collectCronRuns(ended);
  assert.deepEqual(plain(events.map((event) => [event.type, event.title])).sort(), [
    ["cron-failed", "Scheduled run failed: Quiet"],
    ["script-succeeded", "Scheduled run finished: Loud"],
  ]);
  assert.match(events.find((event) => event.type === "script-succeeded").message, /^Loud hourly, started /);
  assert.match(events.find((event) => event.type === "cron-failed").message, /exit code 124: it took longer than its time limit of 20 minutes\./);
  await server.collectCronRuns(ended);
  assert.equal(events.length, 2, "nothing is announced twice");
});

test("an alert that announced its threshold announces once that it is back to normal", () => {
  const { server, readJson } = loadServer();
  const events = [];
  server.onDashboardEvent((event) => events.push(event));
  server.save("alerts", [{ id: "t", name: "CPU hot", metric: "temperature", threshold: 80, cooldownMinutes: 60, enabled: true }]);
  const at = (temperatureC) => server.evaluateAlerts({ stats: { cpuUsagePercent: 0, memoryUsedBytes: 0, memoryTotalBytes: 0, temperatureC, diskUsedPercent: 0, storage: [] }, containers: [] });
  at(85);
  assert.equal(readJson("alerts")[0].active, true);
  at(84);
  at(70);
  at(65);
  assert.deepEqual(plain(events.map((event) => [event.severity, event.title])), [["warning", "Alert: CPU hot"], ["success", "Back to normal: CPU hot"]]);
  assert.match(events[1].message, /^CPU temperature is 70 °C, below the threshold of 80 °C again\.$/);
  assert.equal(readJson("alerts")[0].active, false);
  // A rule turned off while above its threshold ends quietly.
  server.save("alerts", [{ id: "t", name: "CPU hot", metric: "temperature", threshold: 80, cooldownMinutes: 60, enabled: false, active: true }]);
  at(60);
  assert.equal(events.length, 2);
  assert.equal(readJson("alerts")[0].active, false);
});

test("a backup keeps the run conditions and refuses variables on root scripts", async () => {
  const host = (argv) => (argv[0] === "crontab" && argv[1] === "-l" ? { code: 1, stderr: "no crontab for media" } : {});
  const { server, readJson } = loadServer({ host });
  const base = { id: "backup", name: "Backup", path: "/srv/scripts/backup.sh", cron: "", folder: "", runAs: "user", runOptions: [] };
  const settings = { sshTarget: "", scriptRoot: "/srv/scripts", allowedPaths: ["/srv/scripts"], remoteLogs: "/srv/logs", metricsRetentionDays: 30 };
  const backup = (script, schedules = []) => ({ version: 1, scripts: [script], folders: [], schedules, alerts: [], serverSettings: settings });
  await server.restoreConfiguration(backup({ ...base, variables: { KEEP: "3" }, singleRun: true, notifySuccess: true }, [{ id: "n", scriptId: "backup", expression: "0 3 * * *", label: "Nightly", enabled: true, arguments: "--latest" }]));
  const restored = readJson("scripts")[0];
  assert.deepEqual([restored.variables, restored.singleRun, restored.notifySuccess, restored.confirmRun], [{ KEEP: "3" }, true, true, undefined]);
  assert.equal(readJson("schedules")[0].arguments, "--latest");
  await assert.rejects(server.restoreConfiguration(backup({ ...base, runAs: "root", variables: { KEEP: "3" } })), /arguments only/);
});
