import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { loadPower, loadServer, plain } from "./harness.mjs";

const sha256 = (...parts) => createHash("sha256").update(Buffer.concat(parts)).digest();
const sha1 = (value) => createHash("sha1").update(value).digest();

// Starts an HTTP server for one test and returns its host:port.
async function device(handler) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    handler(req, res, Buffer.concat(chunks));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  test.after(() => server.close());
  return `127.0.0.1:${server.address().port}`;
}
const json = (res, body, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

// The plug's side of the KLAP protocol, for the client to talk to.
function fakeTapo({ username, password, milliwatts, on }) {
  const auth = sha256(sha1(username), sha1(password));
  let local, remote, session;
  return (req, res, body) => {
    const url = new URL(req.url, "http://plug");
    if (url.pathname === "/app/handshake1") {
      local = body; remote = randomBytes(16);
      res.writeHead(200, { "set-cookie": "TP_SESSIONID=abc123;TIMEOUT=86400" });
      return res.end(Buffer.concat([remote, sha256(local, remote, auth)]));
    }
    if (req.headers.cookie !== "TP_SESSIONID=abc123") { res.writeHead(403); return res.end(); }
    if (url.pathname === "/app/handshake2") {
      if (!body.equals(sha256(remote, local, auth))) { res.writeHead(403); return res.end(); }
      const derive = (label) => sha256(Buffer.from(label), local, remote, auth);
      session = { key: derive("lsk").subarray(0, 16), iv: derive("iv").subarray(0, 12), sig: derive("ldk").subarray(0, 28) };
      res.writeHead(200); return res.end();
    }
    if (url.pathname === "/app/request") {
      const counter = Buffer.alloc(4); counter.writeInt32BE(Number(url.searchParams.get("seq")));
      const iv = Buffer.concat([session.iv, counter]);
      const encrypted = body.subarray(32);
      assert.ok(body.subarray(0, 32).equals(sha256(session.sig, counter, encrypted)), "request signature");
      const decipher = createDecipheriv("aes-128-cbc", session.key, iv);
      const { method } = JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString());
      const result = method === "get_energy_usage" ? { current_power: milliwatts, today_energy: 10 } : { device_on: on };
      const cipher = createCipheriv("aes-128-cbc", session.key, iv);
      const reply = Buffer.concat([cipher.update(JSON.stringify({ error_code: 0, result })), cipher.final()]);
      res.writeHead(200); return res.end(Buffer.concat([Buffer.alloc(32), reply]));
    }
    res.writeHead(404); res.end();
  };
}
const driver = (power, id) => power.DRIVERS.find((item) => item.id === id);

test("Tapo: KLAP handshake and encrypted requests read power in watts", async () => {
  const power = loadPower(loadServer().server);
  const host = await device(fakeTapo({ username: "me@example.com", password: "secret", milliwatts: 23456, on: true }));
  const reading = await driver(power, "tapo").read({ host, username: "me@example.com", password: "secret" });
  assert.equal(reading.powerW, 23.456);
  assert.equal(reading.on, true);
  await assert.rejects(driver(power, "tapo").read({ host, username: "me@example.com", password: "wrong" }), /not accepted/);
});

test("Shelly: Gen2 RPC, with a fallback to the Gen1 status API", async () => {
  const power = loadPower(loadServer().server);
  const gen2 = await device((req, res) => req.url.startsWith("/rpc/Switch.GetStatus?id=0") ? json(res, { apower: 7.5, output: true }) : json(res, {}, 404));
  assert.deepEqual({ ...(await driver(power, "shelly").read({ host: gen2 })) }, { powerW: 7.5, on: true });
  const gen1 = await device((req, res) => {
    if (req.url.startsWith("/rpc/")) return json(res, {}, 404);
    assert.equal(req.headers.authorization, `Basic ${Buffer.from("admin:pw").toString("base64")}`);
    json(res, { meters: [{ power: 60.2 }], relays: [{ ison: false }] });
  });
  assert.deepEqual({ ...(await driver(power, "shelly").read({ host: gen1, username: "admin", password: "pw" })) }, { powerW: 60.2, on: false });
});

test("Tasmota and Home Assistant readings", async () => {
  const power = loadPower(loadServer().server);
  const tasmota = await device((req, res) => {
    const query = new URL(req.url, "http://t").searchParams;
    assert.equal(query.get("cmnd"), "Status 8");
    json(res, { StatusSNS: { ENERGY: { Power: 42 } } });
  });
  assert.equal((await driver(power, "tasmota").read({ host: tasmota })).powerW, 42);
  const ha = await device((req, res) => {
    if (req.headers.authorization !== "Bearer token-1") return json(res, {}, 401);
    if (req.url === "/api/states/sensor.plug_power") return json(res, { state: "1.25", attributes: { unit_of_measurement: "kW" } });
    if (req.url === "/api/states/switch.plug") return json(res, { state: "on" });
    json(res, {}, 404);
  });
  const reading = await driver(power, "homeassistant").read({ url: `http://${ha}`, token: "token-1", entity: "sensor.plug_power", switch: "switch.plug" });
  assert.deepEqual({ ...reading }, { powerW: 1250, on: true });
  await assert.rejects(driver(power, "homeassistant").read({ url: `http://${ha}`, token: "bad", entity: "sensor.plug_power" }), /401/);
});

test("energy is integrated between readings, but not across long gaps", () => {
  const { server } = loadServer();
  const power = loadPower(server);
  const hour = Math.floor(Date.now() / 3600000) * 3600000;
  power.recordReading("plug", { powerW: 100, on: true }, hour + 60000);
  power.recordReading("plug", { powerW: 100, on: true }, hour + 120000);
  power.recordReading("plug", { powerW: 200, on: true }, hour + 180000);
  let state = power.recordReading("plug", { powerW: 200, on: true }, hour + 180000 + 30 * 60000);
  const wh = state.hourly.at(-1).wh;
  assert.ok(Math.abs(wh - (100 / 60 + 150 / 60)) < 1e-9, `1 min at 100 W + 1 min averaging 150 W, got ${wh}`);
  assert.equal(state.hourly.at(-1).maxW, 200);
  assert.equal(state.recent.length, 4);
  state = power.recordReading("plug", { powerW: 10, on: true }, hour + 180000 + 31 * 60000);
  assert.ok(state.hourly.at(-1).wh > wh, "readings a minute apart count again after the gap");
});

test("secrets stay on the server and a blank secret keeps the stored one", async () => {
  const { server, readJson } = loadServer();
  const power = loadPower(server);
  const host = await device(fakeTapo({ username: "me@example.com", password: "secret", milliwatts: 5000, on: true }));
  await power.savePowerDevice({ name: "Server", driver: "tapo", host, username: "me@example.com", password: "secret" });
  const [shown] = power.publicDevices();
  assert.notEqual(shown.config.password, "secret");
  assert.equal(shown.status.powerW, 5);
  await power.savePowerDevice({ id: shown.id, name: "Server rack", driver: "tapo", host, username: "me@example.com", password: "" });
  const [stored] = readJson("power-devices");
  assert.equal(stored.name, "Server rack");
  assert.equal(stored.config.password, "secret");
  await assert.rejects(power.savePowerDevice({ name: "Other", driver: "tapo", host, username: "me@example.com", password: "wrong" }), /not accepted/);
  assert.equal(readJson("power-devices").length, 1, "a device that cannot be read is not saved");
});

test("long-range power history shows completed hours only", () => {
  const { server } = loadServer();
  const power = loadPower(server);
  const hour = Math.floor(Date.now() / 3600000) * 3600000;
  server.save("power-devices", [{ id: "plug", name: "Plug", driver: "shelly", enabled: true, config: { host: "127.0.0.1" } }]);
  server.save("power", { plug: { recent: [], hourly: [{ at: hour - 3600000, wh: 60, maxW: 70 }, { at: hour, wh: 2, maxW: 60 }] } }, false);
  const week = power.powerHistory("7d");
  assert.deepEqual(plain(week.power[0].points.map((point) => point.w)), [60]);
  assert.equal(week.energy[0].hours.length, 2, "energy still includes the current hour");
});

test("connection failures explain themselves instead of 'fetch failed'", async () => {
  const power = loadPower(loadServer().server);
  // A port that was just free: nothing listens on it any more.
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  await assert.rejects(driver(power, "tasmota").read({ host: `127.0.0.1:${port}` }), new RegExp(`127\\.0\\.0\\.1:${port} refused the connection`));
});

test("a Tapo plug with its local API closed points to the app setting", async () => {
  const power = loadPower(loadServer().server);
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  await assert.rejects(driver(power, "tapo").read({ host: `127.0.0.1:${port}`, username: "me@example.com", password: "x" }), /Third-Party Compatibility/);
});
