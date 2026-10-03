import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadServer, plain } from "./harness.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what, timeout = 20000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline; await pause(50)) if (check()) return;
  throw Error(`Timed out waiting for ${what}`);
}
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const SCRIPT = { id: "slow", name: "Slow job", cron: "", runAs: "user" };
// A script that starts a background process, prints its ID, and waits.
function slowScript(lines = []) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "lsc-run-")), "slow.sh");
  writeFileSync(file, [...lines, "echo started", "sleep 300 &", 'echo "helper $!"', "sleep 300", 'echo "not reached"', ""].join("\n"));
  return file;
}
// Runs a script for real and waits until it has started its background process.
async function startSlowRun(server, data, script) {
  const record = await server.runScript(script);
  const log = () => server.readRunLogEnd(path.join(data, "runs", `${record.id}.log`)) ?? "";
  await until(() => /helper \d+/.test(log()), "the script to start");
  return { record, log, helper: Number(/helper (\d+)/.exec(log())[1]) };
}
const latestRun = (readJson) => readJson("script-runs")[0];

test("a stopped run ends with every process it started, and is recorded as stopped", async () => {
  const { server, data, readJson } = loadServer({ realProcesses: true });
  const events = [];
  server.onDashboardEvent((event) => events.push(event));
  const { record, log, helper } = await startSlowRun(server, data, { ...SCRIPT, path: slowScript() });
  assert.equal(latestRun(readJson).status, "running");
  await server.stopRun(record.id, "maria");
  await until(() => latestRun(readJson).status !== "running", "the run to end");
  const run = latestRun(readJson);
  assert.equal(run.status, "stopped");
  assert.equal(run.stoppedBy, "maria");
  assert.ok(run.durationMs < 9000, "TERM ended it, before the grace period");
  // The wrapper's line naming the process group is not part of the log.
  assert.equal(log(), `started\nhelper ${helper}\n\n[Stopped by maria.]\n`);
  await until(() => !alive(helper), "the background process to end");
  assert.deepEqual(events, [], "a stopped run is no failure to announce");
  await assert.rejects(server.stopRun(record.id, "maria"), /already ended/);
  await assert.rejects(server.stopRun("no-such-run", "maria"), /not found/);
});

test("a run that ignores TERM is killed after the grace period", { timeout: 30000 }, async () => {
  const { server, data, readJson } = loadServer({ realProcesses: true });
  // Ignored signals stay ignored in the processes the script starts.
  const { record, helper } = await startSlowRun(server, data, { ...SCRIPT, path: slowScript(["trap '' TERM"]) });
  await server.stopRun(record.id, "maria");
  await pause(1000);
  assert.equal(latestRun(readJson).status, "running", "TERM is ignored");
  await until(() => latestRun(readJson).status !== "running", "KILL", 20000);
  assert.equal(latestRun(readJson).status, "stopped");
  await until(() => !alive(helper), "the background process to end");
});

test("a run that passes its time limit is stopped and counts as failed", async () => {
  const { server, data, readJson } = loadServer({ realProcesses: true });
  const events = [];
  server.onDashboardEvent((event) => events.push(event));
  // 0.02 minutes is 1.2 seconds; the form only takes whole minutes.
  const { record, log } = await startSlowRun(server, data, { ...SCRIPT, path: slowScript(), timeLimitMinutes: 0.02 });
  await until(() => latestRun(readJson).status !== "running", "the time limit");
  const run = latestRun(readJson);
  assert.equal(run.id, record.id);
  assert.equal(run.status, "failed");
  assert.equal(run.timedOut, true);
  assert.equal(run.stoppedBy, undefined);
  assert.match(log(), /\[Stopped: the run took longer than its time limit of 0\.02 minutes\.\]\n$/);
  assert.equal(events.length, 1);
  assert.match(events[0].message, /stopped after its time limit/);
});

test("a time limit is a whole number of minutes, at most a week", () => {
  const { server } = loadServer();
  for (const none of ["", "0", undefined, "  "]) assert.equal(server.parseTimeLimit(none), undefined);
  assert.equal(server.parseTimeLimit("30"), 30);
  assert.equal(server.parseTimeLimit(10080), 10080);
  for (const invalid of ["1.5", "-1", "10081", "soon"]) assert.throws(() => server.parseTimeLimit(invalid), /time limit/);
});

// The login shells installed here. Over SSH the command line is read by the SSH
// user's login shell, in the session sshd creates for the command.
const SHELLS = ["sh", "bash", "dash", "zsh", "fish"].filter((name) => spawnSync(name, ["-c", "exit 0"]).status === 0);
for (const loginShell of SHELLS) {
  test(`a run through ${loginShell} as the login shell is stopped as a whole`, async () => {
    // An `ssh` that does what sshd would with the command line.
    const bin = mkdtempSync(path.join(tmpdir(), "lsc-ssh-"));
    writeFileSync(path.join(bin, "ssh"), `#!/bin/sh\nfor last; do :; done\nexec setsid -w ${loginShell} -c "$last"\n`, { mode: 0o755 });
    const original = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${original}`;
    try {
      const { server, data, readJson } = loadServer({ realProcesses: true, env: { SSH_TARGET: "admin@server", SSH_MULTIPLEX: "false" } });
      const { record, log, helper } = await startSlowRun(server, data, { ...SCRIPT, path: slowScript() });
      await server.stopRun(record.id, "maria");
      await until(() => latestRun(readJson).status !== "running", "the run to end");
      assert.equal(latestRun(readJson).status, "stopped");
      assert.equal(log(), `started\nhelper ${helper}\n\n[Stopped by maria.]\n`);
      await until(() => !alive(helper), "the background process to end");
    } finally {
      process.env.PATH = original;
    }
  });
}

test("root runs are started with an ID when the helper can stop them", async () => {
  for (const [status, canStop] of [["stop\n", true], ["", false]]) {
    const host = (argv) => (argv[0] === "sudo" && argv[3] === "status" ? { stdout: status } : {});
    const { server, commands } = loadServer({ host });
    assert.deepEqual(plain(await server.rootScriptStatus()), { available: true, stop: canStop });
    const record = await server.runScript({ ...SCRIPT, path: "/srv/scripts/slow.sh", runAs: "root" });
    const started = commands.find((command) => command.argv.includes("/srv/scripts/slow.sh")).argv;
    const helper = started.slice(started.indexOf("sudo"));
    assert.deepEqual(helper, canStop
      ? ["sudo", "-n", "/usr/local/sbin/media-dashboard-root-run", "run", "--id", record.id, "/srv/scripts/slow.sh"]
      : ["sudo", "-n", "/usr/local/sbin/media-dashboard-root-run", "run", "/srv/scripts/slow.sh"]);
    if (canStop) {
      await server.stopRun(record.id, "maria");
      assert.deepEqual(commands.at(-1).argv, ["sudo", "-n", "/usr/local/sbin/media-dashboard-root-run", "stop", record.id, "TERM"]);
    } else await assert.rejects(server.stopRun(record.id, "maria"), /older version/);
  }
});

test("a time limit on a root script needs a helper that can stop it", async () => {
  const folder = mkdtempSync(path.join(tmpdir(), "lsc-root-"));
  const script = path.join(folder, "task.sh");
  writeFileSync(script, "echo task\n");
  for (const [status, allowed] of [["stop\n", true], ["", false]]) {
    // realpath and test run for real; the helper answers with its status.
    const host = (argv) => argv[0] === "sudo" ? { stdout: status } : (() => {
      const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
      return { stdout: result.stdout, stderr: result.stderr, code: result.status };
    })();
    const { server, readJson } = loadServer({ host, env: { ALLOWED_PATHS: folder, SCRIPT_ROOT: folder } });
    const save = server.addScript({ name: "Task", path: script, runAs: "root", timeLimitMinutes: "30", runOptions: "[]" });
    if (allowed) {
      await save;
      assert.equal(readJson("scripts")[0].timeLimitMinutes, 30);
    } else await assert.rejects(save, /current root script helper/);
  }
});

test("the root script helper records, stops and forgets the runs it starts", async () => {
  const folder = mkdtempSync(path.join(tmpdir(), "lsc-helper-"));
  const approved = path.join(folder, "approved");
  mkdirSync(approved);
  const paths = path.join(folder, "root-script-paths"), runs = path.join(folder, "runs");
  writeFileSync(paths, approved + "\n");
  // The helper with its two fixed locations moved here, run as this user.
  const source = fileURLToPath(new URL("../scripts/media-dashboard-root-run", import.meta.url));
  const helper = path.join(folder, "helper");
  writeFileSync(helper, readFileSync(source, "utf8").replace("/etc/media-dashboard/root-script-paths", paths).replace("/run/media-dashboard-root-run", runs), { mode: 0o755 });
  const call = (...args) => spawnSync(helper, args, { encoding: "utf8" });
  assert.equal(call("status").stdout, "stop\n");
  for (const invalid of [["stop", "../escape"], ["stop", "run", "HUP"], ["stop"], ["run", "--id", "a/b", path.join(approved, "x.sh")]])
    assert.equal(call(...invalid).status, 64, invalid.join(" "));
  assert.equal(call("stop", "never-started").status, 0, "an unknown run is no error");
  writeFileSync(path.join(folder, "elsewhere.sh"), "echo no\n");
  assert.equal(call("run", "--id", "outside", path.join(folder, "elsewhere.sh")).status, 77);

  // TERM ends a run and everything it started; the record goes with it.
  writeFileSync(path.join(approved, "slow.sh"), 'sleep 300 &\necho "helper $!"\nsleep 300\n');
  const start = (id) => {
    const child = spawn(helper, ["run", "--id", id, path.join(approved, "slow.sh")], { stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    const ended = new Promise((resolve) => child.on("close", (code) => resolve(code)));
    return { ended, output: () => output };
  };
  const first = start("run-1");
  await until(() => /helper \d+/.test(first.output()) && existsSync(path.join(runs, "run-1")), "the run to start");
  const background = Number(/helper (\d+)/.exec(first.output())[1]);
  assert.equal(call("stop", "run-1").status, 0);
  assert.equal(await first.ended, 143, "the script's own exit status");
  await until(() => !alive(background), "the background process to end");
  assert.ok(!existsSync(path.join(runs, "run-1")), "the record is removed");

  // A script that ignores TERM is ended by KILL.
  writeFileSync(path.join(approved, "slow.sh"), `trap '' TERM\n${readFileSync(path.join(approved, "slow.sh"), "utf8")}`);
  const second = start("run-2");
  await until(() => /helper \d+/.test(second.output()) && existsSync(path.join(runs, "run-2")), "the second run to start");
  call("stop", "run-2", "TERM");
  await pause(500);
  assert.ok(existsSync(path.join(runs, "run-2")), "TERM was ignored");
  call("stop", "run-2", "KILL");
  assert.equal(await second.ended, 137);

  // A record whose process has ended, its ID now another's, signals nothing.
  const bystander = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  try {
    writeFileSync(path.join(runs, "stale"), `${bystander.pid} 1\n`);
    assert.equal(call("stop", "stale", "KILL").status, 0);
    await pause(200);
    assert.ok(alive(bystander.pid), "the other process lives on");
  } finally {
    bystander.kill("SIGKILL");
  }
});

test("a run gets the script's variables and the value typed for its option", async () => {
  const { server, data, readJson } = loadServer({ realProcesses: true });
  const file = path.join(mkdtempSync(path.join(tmpdir(), "lsc-run-")), "show.sh");
  writeFileSync(file, 'echo "greeting=$GREETING keep=$KEEP args=$*"\n');
  const record = await server.runScript({ ...SCRIPT, path: file, variables: { GREETING: "hello world", KEEP: "3" } }, "--luna {value} --yes", "", "2026-06");
  await until(() => latestRun(readJson).status !== "running", "the run to end");
  assert.equal(latestRun(readJson).status, "success");
  assert.equal(latestRun(readJson).arguments, "--luna 2026-06 --yes", "History shows the value that was typed");
  assert.equal(server.readRunLogEnd(path.join(data, "runs", `${record.id}.log`)), "greeting=hello world keep=3 args=--luna 2026-06 --yes\n");
});

test("a script that runs one at a time refuses a second run until the first ends", async () => {
  const { server, data, readJson } = loadServer({ realProcesses: true });
  const script = { ...SCRIPT, path: slowScript(), singleRun: true };
  const { record } = await startSlowRun(server, data, script);
  await assert.rejects(server.runScript(script), /already running, and runs one at a time/);
  // Other scripts are not held up.
  const other = await server.runScript({ ...script, id: "other", singleRun: false });
  await server.stopRun(record.id, "maria");
  await server.stopRun(other.id, "maria");
  await until(() => readJson("script-runs").every((run) => run.status !== "running"), "the runs to end");
  const again = await server.runScript(script);
  await server.stopRun(again.id, "maria");
  await until(() => latestRun(readJson).status !== "running", "the last run to end");
});

test("a script set to announce its successful runs does, with its last line of output", async () => {
  const { server, readJson } = loadServer({ realProcesses: true });
  const events = [];
  server.onDashboardEvent((event) => events.push(event));
  const file = path.join(mkdtempSync(path.join(tmpdir(), "lsc-run-")), "backup.sh");
  writeFileSync(file, 'echo "copying"\necho "3 files saved, 1.2 GB"\necho\n');
  await server.runScript({ ...SCRIPT, path: file, notifySuccess: true });
  await until(() => latestRun(readJson).status !== "running", "the run to end");
  await server.runScript({ ...SCRIPT, id: "quiet", path: file });
  await until(() => readJson("script-runs").every((run) => run.status !== "running"), "the second run to end");
  assert.equal(events.length, 1, "only the script that asks is announced");
  assert.equal(events[0].type, "script-succeeded");
  assert.match(events[0].message, /^The run took \d+ s\. Last output: 3 files saved, 1\.2 GB$/);
});
