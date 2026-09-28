import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { loadNotify, loadPower, loadServer, plain } from "./harness.mjs";

// A webhook receiver that records each request.
async function receiver(status = 204) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.writeHead(status); res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  test.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}
const event = { type: "alert", severity: "critical", title: "Alert: Hot", message: "CPU temperature is 91 °C." };
const allEvents = ["alert", "script-failed", "cron-failed", "power-offline", "power-online"];

test("each channel type formats the event for its service", async () => {
  const { server } = loadServer({ env: { SSH_TARGET: "admin@media-box" } });
  const notify = loadNotify(server);
  const hook = await receiver();
  // Discord URLs are validated, so this one is stored directly for the test.
  server.save("notification-channels", [
    { id: "d", name: "Discord", type: "discord", url: `${hook.url}/discord`, events: allEvents, enabled: true },
    { id: "s", name: "Slack", type: "slack", url: `${hook.url}/slack`, events: allEvents, enabled: true },
    { id: "n", name: "ntfy", type: "ntfy", url: `${hook.url}/ntfy`, events: allEvents, enabled: true },
    { id: "w", name: "Webhook", type: "webhook", url: `${hook.url}/hook`, events: allEvents, enabled: true },
  ]);
  await notify.deliver(event);
  const by = (path) => hook.requests.find((request) => request.path === path);
  const discord = JSON.parse(by("/discord").body);
  assert.equal(discord.embeds[0].title, "Alert: Hot");
  assert.equal(discord.embeds[0].color, 0xd03b3b);
  assert.equal(discord.embeds[0].footer.text, "media-box");
  assert.match(JSON.parse(by("/slack").body).text, /^\*Alert: Hot\*\nCPU temperature is 91 °C\.\n_media-box_$/);
  assert.equal(by("/ntfy").headers.title, "Alert: Hot");
  assert.equal(by("/ntfy").headers.priority, "5");
  assert.match(by("/ntfy").body, /CPU temperature is 91 °C\./);
  assert.deepEqual(Object.keys(JSON.parse(by("/hook").body)).sort(), ["at", "event", "host", "message", "severity", "source", "title"]);
});

test("only enabled channels subscribed to the event receive it, and failures are recorded", async () => {
  const { server, readJson } = loadServer();
  const notify = loadNotify(server);
  const ok = await receiver(), failing = await receiver(500);
  server.save("notification-channels", [
    { id: "a", name: "Alerts", type: "webhook", url: ok.url, events: ["alert"], enabled: true },
    { id: "b", name: "Runs", type: "webhook", url: ok.url, events: ["script-failed"], enabled: true },
    { id: "c", name: "Paused", type: "webhook", url: ok.url, events: ["alert"], enabled: false },
    { id: "d", name: "Broken", type: "webhook", url: failing.url, events: ["alert"], enabled: true },
  ]);
  await notify.deliver(event);
  assert.equal(ok.requests.length, 1);
  const stored = Object.fromEntries(readJson("notification-channels").map((channel) => [channel.id, channel]));
  assert.ok(stored.a.lastSentAt && !stored.a.lastError);
  assert.match(stored.d.lastError, /HTTP 500/);
  await assert.rejects(notify.testChannel("d"), /HTTP 500/);
});

test("webhook URLs are validated and never sent to the browser", async () => {
  const { server, readJson } = loadServer();
  const notify = loadNotify(server);
  const secret = "https://discord.com/api/webhooks/123/very-secret-token";
  assert.throws(() => notify.saveChannel({ type: "discord", name: "D", url: "https://example.com/hook", events: ["alert"] }), /discord\.com\/api\/webhooks/);
  assert.throws(() => notify.saveChannel({ type: "webhook", name: "W", url: "ftp://example.com", events: ["alert"] }), /https:\/\//);
  assert.throws(() => notify.saveChannel({ type: "webhook", name: "W", url: "https://example.com", events: [] }), /at least one event/);
  notify.saveChannel({ type: "discord", name: "Discord", url: secret, events: ["alert", "bogus"] });
  const [shown] = plain(notify.publicChannels());
  assert.equal(shown.url, "discord.com");
  assert.deepEqual(shown.events, ["alert"], "unknown events are dropped");
  notify.saveChannel({ id: shown.id, type: "discord", name: "Renamed", url: "", events: ["alert", "cron-failed"] });
  const [stored] = readJson("notification-channels");
  assert.equal(stored.url, secret, "a blank URL keeps the stored one");
  assert.equal(stored.name, "Renamed");
});

test("alerts, failed scheduled runs and power device changes emit events", async () => {
  const { server } = loadServer({ host: (argv) => (argv[0] === "tail" ? { stdout: log } : { stdout: "" }) });
  const received = [];
  server.onDashboardEvent((item) => received.push(item.type));
  server.save("alerts", [{ id: "a", name: "Hot", metric: "temperature", threshold: 80, cooldownMinutes: 30, enabled: true }]);
  const stats = { temperatureC: 91, cpuUsagePercent: 1, memoryUsedBytes: 1, memoryTotalBytes: 2, diskUsedPercent: 5, storage: [] };
  server.evaluateAlerts({ stats, containers: [] });
  server.evaluateAlerts({ stats, containers: [] });
  assert.deepEqual(received, ["alert"], "the cooldown suppresses repeats");

  let log = "MEDIA_DASHBOARD_START s1 2026-09-27T03:00:00+03:00\nMEDIA_DASHBOARD_END s1 2026-09-27T03:00:05+03:00 1\n";
  await server.collectCronRuns();
  assert.deepEqual(received, ["alert"], "the first collection only learns existing runs");
  log += "MEDIA_DASHBOARD_START s1 2026-09-28T03:00:00+03:00\nMEDIA_DASHBOARD_END s1 2026-09-28T03:00:04+03:00 2\n";
  await server.collectCronRuns();
  await server.collectCronRuns();
  assert.deepEqual(received, ["alert", "cron-failed"], "each new failure is announced once");

  const power = loadPower(server);
  server.save("power-devices", [{ id: "p", name: "Plug", driver: "shelly", enabled: true, config: { host: "127.0.0.1:1" } }]);
  await power.samplePower();
  await power.samplePower();
  assert.deepEqual(received.slice(2), ["power-offline"], "going offline is announced once");
});
