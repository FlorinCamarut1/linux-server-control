// What the dashboard tells about the server beyond its health tiles: alert
// rules that wait, Telegram, the heartbeat, a server that stops answering,
// traffic and load, processes, pending updates, the activity log, and the
// containers' use and updates.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadApi, loadNotify, loadServer, plain, realHost, snapshotAnswer } from "./harness.mjs";

// A receiver that records each request and answers with `status` and `body`.
async function receiver(status = 200, body = "") {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, path: req.url, body: Buffer.concat(chunks).toString() });
    res.writeHead(status, { "content-type": "application/json" }); res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  test.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}
const MINUTE = 60000;
const stats = (overrides = {}) => ({ temperatureC: 50, cpuUsagePercent: 10, memoryUsedBytes: 1, memoryTotalBytes: 2, diskUsedPercent: 5, storage: [], ...overrides });

test("a rule that waits announces a value only once it has stayed there that long", () => {
  let now = Date.parse("2026-11-15T10:00:00Z");
  const { server, readJson } = loadServer({ now: () => now });
  const events = [];
  server.onDashboardEvent((event) => events.push(event));
  server.saveAlert({ id: "busy", name: "Busy", metric: "cpu", threshold: "90", cooldownMinutes: "30", forMinutes: "10", enabled: "true" });
  const evaluate = (cpu) => server.evaluateAlerts({ stats: stats({ cpuUsagePercent: cpu }), containers: [] });
  evaluate(95);
  assert.equal(events.length, 0, "the first reading above the threshold starts the wait");
  assert.equal(readJson("alerts")[0].aboveSince, now);
  assert.deepEqual(plain(server.waitingAlerts()), ["busy"]);
  now += 6 * MINUTE;
  evaluate(50);
  assert.equal(readJson("alerts")[0].aboveSince, undefined, "one reading below starts the wait again");
  now += MINUTE;
  evaluate(96);
  now += 9 * MINUTE;
  evaluate(97);
  assert.equal(events.length, 0, "9 minutes are not 10");
  now += MINUTE;
  evaluate(98);
  assert.equal(events.length, 1);
  assert.equal(events[0].message, "CPU use is 98%, and has stayed at or above the threshold of 90% for 10 min.");
  assert.deepEqual(plain(server.waitingAlerts()), [], "Overview lists it from now on");
  now += MINUTE;
  evaluate(20);
  assert.equal(events.at(-1).title, "Back to normal: Busy");
  assert.equal(readJson("alerts")[0].aboveSince, undefined);
});

test("the wait of a rule is validated, kept when it is edited, and absent for a rule that does not wait", () => {
  const { server, readJson } = loadServer();
  const input = { metric: "cpu", threshold: "90", cooldownMinutes: "30", enabled: "true" };
  assert.equal(server.normalizeAlert(input).forMinutes, undefined);
  assert.equal(server.normalizeAlert({ ...input, forMinutes: "0" }).forMinutes, undefined);
  assert.equal(server.normalizeAlert({ ...input, forMinutes: "15" }).forMinutes, 15);
  for (const invalid of ["-1", "1.5", "2000", "soon"]) assert.throws(() => server.normalizeAlert({ ...input, forMinutes: invalid }), /Invalid alert values/, invalid);
  server.save("alerts", [{ id: "a", name: "Busy", metric: "cpu", threshold: 90, cooldownMinutes: 30, enabled: true, forMinutes: 10, aboveSince: 1000 }]);
  server.saveAlert({ ...input, id: "a", name: "Busy", forMinutes: "20" });
  assert.equal(readJson("alerts")[0].aboveSince, 1000, "an edited rule goes on waiting from where it was");
  server.saveAlert({ ...input, id: "a", name: "Busy" });
  assert.equal(readJson("alerts")[0].aboveSince, undefined);
  // A rule that does not wait is not written again on every reading.
  const before = readFileSync(path.join(server.DATA, "alerts.json"), "utf8");
  server.evaluateAlerts({ stats: stats({ cpuUsagePercent: 50 }), containers: [] });
  assert.equal(readFileSync(path.join(server.DATA, "alerts.json"), "utf8"), before);
});

test("a Telegram channel sends the event to its chat as HTML, and says what Telegram answers", async () => {
  const { server, readJson } = loadServer({ env: { SSH_TARGET: "admin@media-box" } });
  const notify = loadNotify(server);
  const hook = await receiver(), refusing = await receiver(400, JSON.stringify({ ok: false, description: "Bad Request: chat not found" }));
  server.save("notification-channels", [
    { id: "t", name: "Telegram", type: "telegram", url: `${hook.url}/botTOKEN/sendMessage`, chat: "-100123", events: ["alert"], enabled: true },
    { id: "r", name: "Wrong chat", type: "telegram", url: `${refusing.url}/botTOKEN/sendMessage`, chat: "1", events: ["alert"], enabled: true },
  ]);
  await notify.deliver({ type: "alert", severity: "warning", title: "Alert: <Hot> & busy", message: "CPU temperature is 91 °C." });
  const sent = JSON.parse(hook.requests[0].body);
  assert.equal(sent.chat_id, "-100123");
  assert.equal(sent.parse_mode, "HTML");
  assert.equal(sent.text, "<b>Alert: &lt;Hot&gt; &amp; busy</b>\nCPU temperature is 91 °C.\n<i>media-box</i>");
  const stored = Object.fromEntries(readJson("notification-channels").map((channel) => [channel.id, channel]));
  assert.ok(stored.t.lastSentAt && !stored.t.lastError);
  assert.equal(stored.r.lastError, "Telegram answered: Bad Request: chat not found");
});

test("a Telegram channel is saved from a bot token and a chat, and the token is never sent to the browser", () => {
  const { server, readJson } = loadServer();
  const notify = loadNotify(server);
  const token = "123456789:AAH-abcdefghijklmnopqrstuvwxyz_12345";
  const channel = { type: "telegram", name: "Phone", events: ["alert"] };
  assert.throws(() => notify.saveChannel({ ...channel, url: "not a token", chat: "1" }), /bot token looks like/);
  assert.throws(() => notify.saveChannel({ ...channel, url: "", chat: "1" }), /Enter the bot token/);
  for (const chat of ["", "my chat", "@x", "12a"]) assert.throws(() => notify.saveChannel({ ...channel, url: token, chat }), /chat ID/, chat);
  notify.saveChannel({ ...channel, url: token, chat: "-1001234567890" });
  const [stored] = readJson("notification-channels");
  assert.equal(stored.url, `https://api.telegram.org/bot${token}/sendMessage`);
  assert.equal(stored.chat, "-1001234567890");
  const [shown] = plain(notify.publicChannels());
  assert.equal(shown.url, "api.telegram.org");
  assert.ok(!JSON.stringify(shown).includes(token));
  // Editing without a new token keeps the stored one; the chat can change.
  notify.saveChannel({ ...channel, id: stored.id, url: "", chat: "@my_channel" });
  assert.equal(readJson("notification-channels")[0].url, stored.url);
  assert.equal(readJson("notification-channels")[0].chat, "@my_channel");
  const type = notify.CHANNEL_TYPES.find((item) => item.id === "telegram");
  assert.ok(type.secret && type.chat.label, "the form asks for a token and a chat instead of a webhook URL");
});

test("the heartbeat address is called, its result recorded, and only its host shown", async () => {
  const { server, readJson } = loadServer();
  const up = await receiver(), down = await receiver(500);
  assert.throws(() => server.saveHeartbeat({ url: "hc-ping.com/abc" }), /address the monitoring service gave you/);
  assert.throws(() => server.saveHeartbeat({ url: "ftp://example.com/abc" }), /https:\/\/ or http:\/\//);
  await assert.rejects(server.pingHeartbeat(), /No heartbeat address is set/);
  await server.sendHeartbeat();
  assert.equal(up.requests.length, 0, "nothing is called while no address is set");
  server.saveHeartbeat({ url: `${up.url}/ping/secret-check-id` });
  const shown = plain(server.heartbeatState());
  assert.equal(shown.set, true);
  assert.equal(shown.host, new URL(up.url).host);
  assert.ok(!JSON.stringify(shown).includes("secret-check-id"), "the check's secret stays on the server");
  assert.equal(shown.lastPingAt, null);
  await server.sendHeartbeat();
  assert.deepEqual(up.requests.map((request) => `${request.method} ${request.path}`), ["GET /ping/secret-check-id"]);
  assert.ok(server.heartbeatState().lastPingAt);
  assert.equal(server.heartbeatState().lastError, null);
  server.saveHeartbeat({ url: `${down.url}/ping` });
  await assert.rejects(server.pingHeartbeat(), /answered HTTP 500/);
  assert.equal(server.heartbeatState().lastError, "The address answered HTTP 500");
  await server.sendHeartbeat();
  assert.equal(down.requests.length, 2, "the background monitor's call fails quietly, and is made again next time");
  server.saveHeartbeat({ url: " " });
  assert.deepEqual(readJson("heartbeat"), {});
  assert.equal(server.heartbeatState().set, false);
});

test("a server that stops answering is announced once, and again when it answers", () => {
  let now = Date.parse("2026-11-15T10:00:00Z");
  const { server, readJson } = loadServer({ now: () => now });
  const events = [];
  server.onDashboardEvent((event) => events.push(event));
  // One failed reading, as during a restart, is not worth a notification.
  server.hostUnreachable("ssh: connect to host server port 22: Connection refused");
  now += 5 * MINUTE;
  server.hostReachable();
  assert.equal(events.length, 0);
  assert.deepEqual(readJson("host-status"), { failures: 0 });
  server.hostUnreachable("timed out");
  now += 5 * MINUTE;
  server.hostUnreachable("ssh: connect to host server port 22: Connection refused");
  now += 5 * MINUTE;
  server.hostUnreachable("ssh: connect to host server port 22: Connection refused");
  assert.equal(events.length, 1, "announced at the second failure, and not again");
  assert.deepEqual([events[0].type, events[0].severity, events[0].title], ["server-unreachable", "critical", "The server does not answer"]);
  assert.equal(events[0].message, "The dashboard could not read the server for 5 min: ssh: connect to host server port 22: Connection refused");
  // What was announced survives a restart of the dashboard.
  assert.equal(readJson("host-status").announced, true);
  now += 5 * MINUTE;
  server.hostReachable();
  assert.deepEqual([events[1].severity, events[1].title, events[1].message], ["success", "The server answers again", "It did not answer the dashboard for 15 min."]);
  server.hostReachable();
  assert.equal(events.length, 2);
  assert.ok("server-unreachable" in server.EVENT_TYPES, "a channel can subscribe to it");
});

test("a refresh reads swap, load and the network counters, and works out the traffic between two", async () => {
  let now = Date.parse("2026-11-15T10:00:00Z"), rx = 1_000_000, tx = 500_000;
  const output = () => `cpuUsagePercent=1.0\nmemoryTotalBytes=1000\nswapTotalBytes=4000\nswapUsedBytes=1000\nload1=1.50\nload5=1.20\nload15=0.90\nnetRxBytes=${rx}\nnetTxBytes=${tx}\n`;
  const { server } = loadServer({ now: () => now, host: (argv) => snapshotAnswer(argv, { stats: output() }) });
  const first = (await server.hostSnapshot()).stats;
  assert.deepEqual([first.swapUsedBytes, first.swapTotalBytes, first.load1, first.load5, first.load15], [1000, 4000, 1.5, 1.2, 0.9]);
  assert.equal(first.netRxBytesPerSecond, null, "one reading says nothing about the traffic");
  assert.equal(server.recordMetricSample(first), true);
  now += 10_000; rx += 2_000_000; tx += 100_000;
  const second = (await server.hostSnapshot()).stats;
  assert.deepEqual([second.netRxBytesPerSecond, second.netTxBytesPerSecond], [200_000, 10_000]);
  // A sample holds the average since the sample before, not the last seconds'.
  now += 290_000; rx += 1_000_000; tx += 200_000;
  const third = (await server.hostSnapshot()).stats;
  assert.equal(server.recordMetricSample(third), true);
  const sample = server.metricSamples().at(-1);
  assert.deepEqual([sample.load, sample.swap, sample.netRx, sample.netTx], [1.5, 25, 10_000, 1000]);
  assert.equal(server.metricSamples()[0].netRx, null);
  const history = server.metricHistory("24h", 288, now);
  assert.deepEqual([history.samples.at(-1).load, history.samples.at(-1).swap, history.samples.at(-1).netRx], [1.5, 25, 10_000]);
  // Counters that start again from zero, after a restart, give no traffic.
  now += 10_000; rx = 5000; tx = 5000;
  assert.equal((await server.hostSnapshot()).stats.netRxBytesPerSecond, null);
});

test("a server without swap or network counters has neither", async () => {
  const { server } = loadServer({ host: (argv) => snapshotAnswer(argv, { stats: "cpuUsagePercent=1.0\nmemoryTotalBytes=1000\nswapTotalBytes=0\nswapUsedBytes=0\nload1=0.10\nnetRxBytes=\nnetTxBytes=\n" }) });
  const { stats: read } = await server.hostSnapshot();
  assert.deepEqual([read.netRxBytes, read.netTxBytes, read.netRxBytesPerSecond], [null, null, null]);
  server.recordMetricSample(read);
  const sample = server.metricSamples()[0];
  assert.deepEqual([sample.swap, sample.netRx, sample.netTx, sample.load], [null, null, null, 0.1]);
});

test("the statistics script reads this machine's swap, load and network counters", async () => {
  const { server } = loadServer({ host: realHost, env: { MONITORED_PATHS: "/" } });
  const { stats: read } = await server.hostSnapshot();
  assert.ok(read.memoryTotalBytes > 0);
  assert.ok(read.load1 >= 0 && Number.isFinite(read.load15));
  assert.ok(Number.isInteger(read.swapTotalBytes) && read.swapUsedBytes <= read.swapTotalBytes);
  assert.ok(read.netRxBytes !== null && read.netTxBytes !== null, "an interface other than lo was counted");
});

test("the processes that use the most CPU and memory are listed, the busiest first", () => {
  const { server } = loadServer();
  const output = ["total 400", "page 4096",
    "process 10 200 25600 ffmpeg", "process 11 0 512000 java", "process 12 20 100 my (odd) name", "process 13 0 0 kworker/0:1", "process 14 4 10 sshd",
    ...Array.from({ length: 20 }, (_, index) => `process ${100 + index} 0 ${index + 1} idle${index}`)].join("\n");
  const processes = plain(server.processesFromOutput(output));
  assert.deepEqual(processes.slice(0, 4), [
    { pid: 10, name: "ffmpeg", cpuPercent: 50, memoryBytes: 25600 * 4096 },
    { pid: 12, name: "my (odd) name", cpuPercent: 5, memoryBytes: 100 * 4096 },
    { pid: 14, name: "sshd", cpuPercent: 1, memoryBytes: 10 * 4096 },
    { pid: 11, name: "java", cpuPercent: 0, memoryBytes: 512000 * 4096 },
  ]);
  assert.ok(!processes.some((process) => process.pid === 13), "a process that uses neither is left out");
  assert.equal(processes.length, 9, "the three busiest and the eight largest, each listed once");
  assert.deepEqual(plain(server.processesFromOutput("")), []);
});

test("the processes script reads this machine's processes, whatever their names", async () => {
  // A process whose name holds spaces and parentheses, which is also how
  // /proc marks where the name ends: a script is named after its file.
  const bin = mkdtempSync(path.join(tmpdir(), "lsc-proc-"));
  const odd = path.join(bin, "my (odd) name");
  writeFileSync(odd, "#!/bin/sh\nwhile :; do sleep 1; done\n", { mode: 0o755 });
  const child = spawn(odd, [], { stdio: "ignore" });
  try {
    const { server } = loadServer({ host: realHost });
    const { processes, at } = await server.topProcesses();
    assert.ok(at > 0 && processes.length > 0);
    assert.ok(processes.every((process) => Number.isInteger(process.pid) && process.name && process.cpuPercent >= 0 && process.cpuPercent <= 100 && process.memoryBytes >= 0));
    // Every process is read, the odd one among them, before the cut to the top ones.
    const all = realHost(["bash", "-c", server.PROCESSES_SCRIPT, "processes"]).stdout;
    assert.match(all, /^total \d+\npage \d+\n/);
    assert.match(all, new RegExp(`^process ${child.pid} \\d+ \\d+ my \\(odd\\) name$`, "m"));
  } finally {
    child.kill();
  }
});

test("what the system reports is read into updates, a restart and failed services", () => {
  const { server } = loadServer();
  const report = plain(server.systemFromOutput("os=Ubuntu 24.04.3 LTS\nkernel=6.8.0-60-generic\nmanager=apt\nupdates=14\nsecurity=3\nrestart=yes\nunits=read\nunit=nginx.service\nunit=backup.timer\n", 5));
  assert.deepEqual(report, { os: "Ubuntu 24.04.3 LTS", kernel: "6.8.0-60-generic", manager: "apt", updates: 14, security: 3, restartNeeded: true, failedUnits: ["nginx.service", "backup.timer"], at: 5 });
  // What the server could not say is not known, rather than zero or no.
  const unknown = plain(server.systemFromOutput("os=Alpine Linux v3.20\nkernel=6.6.1\nmanager=\nupdates=\nsecurity=\nrestart=\n", 5));
  assert.deepEqual([unknown.updates, unknown.security, unknown.restartNeeded, unknown.failedUnits], [null, null, null, null]);
  const fine = plain(server.systemFromOutput("manager=dnf\nupdates=0\nsecurity=\nrestart=no\nunits=read\n", 5));
  assert.deepEqual([fine.updates, fine.security, fine.restartNeeded, fine.failedUnits], [0, null, false, []]);
});

test("the system script runs on this machine, and its report is kept for a while", async () => {
  const { server, commands } = loadServer({ host: realHost });
  const report = await server.systemReport();
  assert.ok(report.kernel, "the kernel is named");
  assert.ok(report.updates === null || Number.isInteger(report.updates));
  assert.ok(report.failedUnits === null || Array.isArray(report.failedUnits));
  assert.equal(await server.systemReport(), report, "a recent report is not read again");
  assert.equal(commands.length, 1);
  await server.systemReport(true);
  assert.equal(commands.length, 2, "Check now reads it again");
});

test("the activity log is read newest first, a page at a time, and searched", () => {
  const { server, data } = loadServer();
  writeFileSync(path.join(data, "audit.log.1"), "2026-11-01T08:00:00.000Z [admin] login admin\nnot an entry\n");
  server.asActor("admin", () => server.audit("run script Backup (r1)"));
  server.asActor("guest.user", () => server.audit("login guest.user"));
  server.audit("alert triggered Hot: 91");
  const all = plain(server.auditPage({}));
  assert.equal(all.total, 4);
  assert.deepEqual(all.entries.map((entry) => `${entry.account}|${entry.text}`), ["|alert triggered Hot: 91", "guest.user|login guest.user", "admin|run script Backup (r1)", "admin|login admin"]);
  assert.match(all.entries[0].at, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(plain(server.auditPage({ search: "LOGIN" })).entries.map((entry) => entry.account), ["guest.user", "admin"]);
  assert.deepEqual(plain(server.auditPage({ search: "guest" })).total, 1, "the account is searched too");
  const second = plain(server.auditPage({ offset: 1, limit: 2 }));
  assert.deepEqual([second.total, second.entries.length, second.entries[0].text], [4, 2, "login guest.user"]);
  assert.equal(plain(server.auditPage({ search: "nothing like this" })).total, 0);
});

test("each running container's CPU and memory use is read from docker stats", async () => {
  const lines = [
    JSON.stringify({ Name: "jellyfin", CPUPerc: "12.34%", MemUsage: "310.5MiB / 15.5GiB", MemPerc: "1.95%" }),
    JSON.stringify({ Name: "idle", CPUPerc: "--", MemUsage: "-- / --", MemPerc: "--" }),
    "not json",
  ].join("\n");
  const { server, commands } = loadServer({ host: () => ({ stdout: lines }) });
  assert.deepEqual(plain(await server.containerStats()), {
    jellyfin: { cpuPercent: 12.34, memory: "310.5MiB", memoryPercent: 1.95 },
    idle: { cpuPercent: null, memory: "--", memoryPercent: null },
  });
  assert.deepEqual(plain(commands[0].argv.slice(0, 3)), ["docker", "stats", "--no-stream"]);
});

test("updating a container says whether a newer image arrived, or why it cannot", async () => {
  const answers = { stdout: "lsc-image sha256:old sha256:new\n" };
  const { server, commands, data } = loadServer({ host: () => answers });
  assert.deepEqual(plain(await server.updateContainer("jellyfin")), { updated: true });
  assert.deepEqual(plain(commands[0].argv.slice(-3, -1)), ["update", "jellyfin"], "the name is an argument, never part of the script");
  Object.assign(answers, { stdout: "lsc-image sha256:same sha256:same\n" });
  assert.deepEqual(plain(await server.updateContainer("jellyfin")), { updated: false });
  assert.match(readFileSync(path.join(data, "audit.log"), "utf8"), /container jellyfin updated to a new image\n.*container jellyfin checked for a new image: none\n$/);
  for (const [word, message] of [["lsc:not-compose", /not started with Docker Compose/], ["lsc:self", /its own container/], ["lsc:no-compose", /Docker Compose is not installed/], ["lsc:no-folder", /no longer on the server/]]) {
    Object.assign(answers, { stdout: "", stderr: word + "\n", code: 3 });
    await assert.rejects(server.updateContainer("jellyfin"), message, word);
  }
  Object.assign(answers, { stderr: "Error response from daemon: pull access denied for example/app\n", code: 1 });
  await assert.rejects(server.updateContainer("jellyfin"), /pull access denied/, "what Docker says is passed on");
  await assert.rejects(server.updateContainer("--force"), /Invalid container name/);
});

test("the update script runs Compose with the project, folder and files the container was started with", async () => {
  // A \`docker\` that answers for one Compose container and records what Compose is asked.
  const bin = mkdtempSync(path.join(tmpdir(), "lsc-compose-"));
  const project = mkdtempSync(path.join(tmpdir(), "lsc-project-"));
  const log = path.join(bin, "compose.log"), image = path.join(bin, "image");
  writeFileSync(image, "sha256:old");
  writeFileSync(path.join(bin, "docker"), `#!/bin/sh
if [ "$1" = inspect ]; then
  for name; do :; done
  case "$name" in
    plain) printf '\\n\\n\\n\\n%s\\n%s\\n' abcdef0123456789 sha256:x ;;
    app) case "$3" in *Config*) printf '%s\\n' media app '${project}' '${project}/compose.yml,${project}/override with space.yml' abcdef0123456789 "$(cat '${image}')" ;; *) cat '${image}'; echo ;; esac ;;
    *) echo "Error response from daemon: No such container: $name" >&2; exit 1 ;;
  esac
  exit 0
fi
if [ "$1" = compose ]; then
  shift
  [ "$1" = version ] && exit 0
  printf '%s|' "$PWD" "$@" >> '${log}'; echo >> '${log}'
  for last; do :; done
  case "$*" in *" pull "*) printf sha256:new > '${image}' ;; esac
  exit 0
fi
exit 1
`, { mode: 0o755 });
  const host = (argv, input) => {
    const result = spawnSync(argv[0], argv.slice(1), { input: input ?? "", encoding: "utf8", env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
    return { stdout: result.stdout, stderr: result.stderr, code: result.status ?? 1 };
  };
  const { server } = loadServer({ host });
  assert.deepEqual(plain(await server.updateContainer("app")), { updated: true });
  const [pull, up] = readFileSync(log, "utf8").trim().split("\n");
  const shared = `${project}|-p|media|--project-directory|${project}|-f|${project}/compose.yml|-f|${project}/override with space.yml|`;
  assert.equal(pull, `${shared}pull|app|`);
  assert.equal(up, `${shared}up|-d|--no-deps|app|`, "only this service is started again, not what it depends on");
  assert.deepEqual(plain(await server.updateContainer("app")), { updated: false }, "with no newer image the container keeps the one it has");
  await assert.rejects(server.updateContainer("plain"), /not started with Docker Compose/);
  await assert.rejects(server.updateContainer("missing"), /No such container: missing/);
});

test("a file is uploaded whole or not at all, and never over another", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "lsc-upload-"));
  writeFileSync(path.join(root, "taken.txt"), "mine\n");
  const { server, data } = loadServer({ realProcesses: true, env: { ALLOWED_PATHS: root, SCRIPT_ROOT: root } });
  const parts = async function* (...chunks) { for (const chunk of chunks) yield Buffer.from(chunk); };
  const large = Buffer.alloc(3 * 1024 * 1024, "x");
  assert.deepEqual(plain(await server.uploadFile(root, "film (2026).mkv", large.length, parts(large.subarray(0, 1000), large.subarray(1000)))), { ok: true, path: path.join(root, "film (2026).mkv") });
  assert.ok(readFileSync(path.join(root, "film (2026).mkv")).equals(large));
  await server.uploadFile(root, "empty.txt", 0, parts());
  assert.equal(readFileSync(path.join(root, "empty.txt"), "utf8"), "");
  await assert.rejects(server.uploadFile(root, "taken.txt", 4, parts("new\n")), /already exists/);
  assert.equal(readFileSync(path.join(root, "taken.txt"), "utf8"), "mine\n");
  // What arrives is not the file when the connection broke off on the way.
  await assert.rejects(server.uploadFile(root, "cut.bin", 100, parts("only this")), /interrupted; nothing was saved/);
  const broken = async function* () { yield Buffer.from("start"); throw Error("the browser went away"); };
  await assert.rejects(server.uploadFile(root, "gone.bin", 100, broken()), /the browser went away/);
  assert.deepEqual(spawnSync("ls", ["-A", root], { encoding: "utf8" }).stdout.trim().split("\n").sort(), ["empty.txt", "film (2026).mkv", "taken.txt"], "nothing is left of an upload that failed");
  for (const name of ["", ".", "..", "a/b", "a\\b", "x".repeat(256)]) await assert.rejects(server.uploadFile(root, name, 1, parts("x")), /valid name/, JSON.stringify(name));
  await assert.rejects(server.uploadFile(root, ".env", 1, parts("x")), /Hidden files/);
  await server.uploadFile(root, ".env", 1, parts("x"), true);
  await assert.rejects(server.uploadFile(root, "x", NaN, parts("x")), /how large/);
  await assert.rejects(server.uploadFile(path.dirname(root), "x", 1, parts("x")), /outside the allowed locations/);
  assert.match(readFileSync(path.join(data, "audit.log"), "utf8"), /uploaded file .*film \(2026\)\.mkv\n/);
});

test("a file is downloaded as it is read, with its size, from the allowed locations only", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "lsc-download-"));
  const root = path.join(base, "allowed");
  spawnSync("mkdir", ["-p", path.join(root, ".ssh")]);
  const large = Buffer.alloc(2 * 1024 * 1024 + 7);
  for (let index = 0; index < large.length; index++) large[index] = index % 251;
  writeFileSync(path.join(root, "film.mkv"), large);
  writeFileSync(path.join(root, "empty"), "");
  writeFileSync(path.join(root, ".ssh", "key"), "secret");
  writeFileSync(path.join(base, "outside.txt"), "secret");
  const { server } = loadServer({ realProcesses: true, env: { ALLOWED_PATHS: root, SCRIPT_ROOT: root } });
  const read = async (stream) => {
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  };
  const file = await server.downloadFile(path.join(root, "film.mkv"));
  assert.deepEqual([file.name, file.size], ["film.mkv", large.length]);
  assert.ok((await read(file.stream)).equals(large));
  const empty = await server.downloadFile(path.join(root, "empty"));
  assert.equal(empty.size, 0);
  assert.equal((await read(empty.stream)).length, 0);
  await assert.rejects(server.downloadFile(path.join(base, "outside.txt")), /inside an allowed location/);
  await assert.rejects(server.downloadFile(path.join(root, "missing")), /File not found/);
  await assert.rejects(server.downloadFile(root), /regular file/);
  await assert.rejects(server.downloadFile(path.join(root, ".ssh", "key")), /Hidden files/);
  assert.equal((await read((await server.downloadFile(path.join(root, ".ssh", "key"), true)).stream)).toString(), "secret");
  // A download that the browser gives up ends the process that reads the file.
  const given = await server.downloadFile(path.join(root, "film.mkv"));
  await given.stream.cancel();
});

test("a read-only account reads the system, processes and container use, and nothing that changes or reveals more", () => {
  const { server } = loadServer();
  const { auth } = loadApi(server);
  for (const route of ["GET system", "GET processes", "GET container/stats"]) assert.equal(auth.permitted(route, "viewer", {}), true, route);
  for (const route of ["GET audit", "POST container/update", "GET file/download", "POST file/upload", "GET heartbeat", "POST heartbeat/save", "POST heartbeat/test"]) {
    assert.equal(auth.permitted(route, "viewer", {}), false, route);
    assert.equal(auth.permitted(route, "admin", {}), true, route);
  }
});
