import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { audit, emitDashboardEvent, read, save, serverSettings } from "./server";

// Smart plugs and energy meters. Each device model is a driver: the fields
// its settings form needs, how to read the current power and, where the device
// has a relay, how to switch it. Readings are taken every minute; energy is
// the power integrated over time, the same way for every driver.

export type PowerReading = { powerW: number; on: boolean | null };
export type DriverField = { key: string; label: string; secret?: boolean; required?: boolean; placeholder?: string; help?: string };
type Config = Record<string, string>;
export type Driver = {
  id: string; name: string; description: string; fields: DriverField[];
  read(config: Config): Promise<PowerReading>;
  // Turns the device's relay on or off; absent when the driver cannot.
  switch?(config: Config, on: boolean): Promise<void>;
  // Whether this device can be switched; every device of a driver with `switch` when absent.
  switchable?(config: Config): boolean;
};

const TIMEOUT_MS = 8000;
// fetch only says "fetch failed"; the reason is in its cause (or, for
// node:http, on the error itself).
export function connectionError(error: unknown, target: string) {
  const failure = error as { code?: string; name?: string; cause?: { code?: string } };
  const code = failure?.cause?.code ?? failure?.code ?? failure?.name;
  if (code === "ECONNREFUSED") return Error(`${target} refused the connection. Check the IP address; the device may have a new one.`);
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return Error(`${target} cannot be reached from the server. Check that it is on the same network.`);
  if (code === "TimeoutError" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return Error(`${target} did not answer within ${TIMEOUT_MS / 1000} seconds. Check that it is powered and on the same network.`);
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return Error(`The name ${target} could not be resolved.`);
  return Error((error as { message?: string })?.message || String(error));
}
// Each driver reads and checks the fields it needs from its device's JSON.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DeviceResponse = { status: number; cookie: string; body: Buffer; json(): any };
// Devices are called with node:http rather than fetch: fetch sends header
// names in lower case, and Tapo plugs answer such requests with HTTP 400.
function request(url: string, init: { method?: string; headers?: Record<string, string>; body?: Buffer } = {}) {
  const target = new URL(url);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<DeviceResponse>((resolve, reject) => {
    const req = send(target, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: { Accept: "*/*", ...(init.body ? { "Content-Length": String(init.body.length) } : {}), ...init.headers },
      timeout: TIMEOUT_MS,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", (error) => reject(connectionError(error, target.host)));
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) return reject(Error(`The device answered HTTP ${status}`));
        const body = Buffer.concat(chunks);
        const cookie = (res.headers["set-cookie"]?.[0] ?? "").split(";")[0];
        resolve({ status, cookie, body, json: () => JSON.parse(body.toString("utf8")) });
      });
    });
    req.on("timeout", () => req.destroy(Object.assign(Error("timed out"), { name: "TimeoutError" })));
    req.on("error", (error) => reject(connectionError(error, target.host)));
    req.end(init.body);
  });
}
const host = (value: string) => {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^[\w.:[\]-]+$/.test(trimmed)) throw Error("Enter the device's IP address or host name");
  return trimmed;
};
const watts = (value: unknown) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw Error("The device did not report its power");
  return Math.max(0, number);
};

// TP-Link Tapo P110/P115 over the local KLAP protocol: a two-step handshake
// proves both sides know the Tapo account, then requests are AES encrypted.
const sha256 = (...parts: Buffer[]) => createHash("sha256").update(Buffer.concat(parts)).digest();
const sha1 = (value: string) => createHash("sha1").update(value).digest();
export class KlapSession {
  private key!: Buffer;
  private ivPrefix!: Buffer;
  private signature!: Buffer;
  private seq = 0;
  private cookie = "";
  constructor(private base: string, private auth: Buffer) {}
  static authHash(username: string, password: string) {
    return sha256(sha1(username), sha1(password));
  }
  async handshake() {
    const localSeed = randomBytes(16);
    const first = await request(`${this.base}/app/handshake1`, { method: "POST", body: localSeed });
    this.cookie = first.cookie;
    const reply = first.body;
    const remoteSeed = reply.subarray(0, 16);
    if (reply.length < 48 || !sha256(localSeed, remoteSeed, this.auth).equals(reply.subarray(16, 48)))
      throw Error("The Tapo account email or password is not accepted by the plug");
    await request(`${this.base}/app/handshake2`, { method: "POST", headers: { Cookie: this.cookie }, body: sha256(remoteSeed, localSeed, this.auth) });
    const derive = (label: string) => sha256(Buffer.from(label), localSeed, remoteSeed, this.auth);
    this.key = derive("lsk").subarray(0, 16);
    const iv = derive("iv");
    this.ivPrefix = iv.subarray(0, 12);
    this.seq = iv.readInt32BE(28);
    this.signature = derive("ldk").subarray(0, 28);
  }
  private iv(seq: number) {
    const counter = Buffer.alloc(4);
    counter.writeInt32BE(seq);
    return { iv: Buffer.concat([this.ivPrefix, counter]), counter };
  }
  async call(method: string, params?: Record<string, unknown>) {
    this.seq = this.seq === 0x7fffffff ? -0x80000000 : this.seq + 1;
    const { iv, counter } = this.iv(this.seq);
    const cipher = createCipheriv("aes-128-cbc", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(params ? { method, params } : { method })), cipher.final()]);
    const body = Buffer.concat([sha256(this.signature, counter, encrypted), encrypted]);
    const response = await request(`${this.base}/app/request?seq=${this.seq}`, { method: "POST", headers: { Cookie: this.cookie }, body });
    const decipher = createDecipheriv("aes-128-cbc", this.key, iv);
    const payload = response.body.subarray(32);
    const result = JSON.parse(Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8"));
    if (result.error_code !== 0) throw Error(`The plug returned error ${result.error_code}`);
    return result.result;
  }
}
async function tapoSession(config: Config) {
  const session = new KlapSession(`http://${host(config.host)}`, KlapSession.authHash(config.username.trim(), config.password));
  try {
    await session.handshake();
  } catch (error) {
    // Newer firmware closes the local API until it is allowed in the app.
    if (error instanceof Error && error.message.includes("refused the connection"))
      throw Error(`${config.host.trim()} refused the connection. In the Tapo app, turn on Me > Third-Party Services > Third-Party Compatibility, then try again.`);
    throw error;
  }
  return session;
}
const tapo: Driver = {
  id: "tapo",
  name: "TP-Link Tapo (P110, P115)",
  description: "Read directly on the LAN with the Tapo account used in the Tapo app.",
  fields: [
    { key: "host", label: "IP address", required: true, placeholder: "192.168.1.40" },
    { key: "username", label: "Tapo account email", required: true },
    { key: "password", label: "Tapo account password", secret: true, required: true },
  ],
  async read(config) {
    const session = await tapoSession(config);
    const energy = await session.call("get_energy_usage");
    const info = await session.call("get_device_info").catch(() => null);
    // get_energy_usage reports current_power in milliwatts.
    return { powerW: watts(energy?.current_power) / 1000, on: typeof info?.device_on === "boolean" ? info.device_on : null };
  },
  async switch(config, on) {
    await (await tapoSession(config)).call("set_device_info", { device_on: on });
  },
};

const shellyGen1Headers = (config: Config): Record<string, string> =>
  config.username ? { Authorization: `Basic ${Buffer.from(`${config.username}:${config.password || ""}`).toString("base64")}` } : {};
const shelly: Driver = {
  id: "shelly",
  name: "Shelly (Plug S, Plus/Pro plugs, PM)",
  description: "Local HTTP API. Gen2+ devices need authentication turned off; Gen1 supports a user and password.",
  fields: [
    { key: "host", label: "IP address", required: true, placeholder: "192.168.1.50" },
    { key: "channel", label: "Channel", placeholder: "0", help: "The relay or meter number, 0 for single plugs." },
    { key: "username", label: "User (Gen1 only)" },
    { key: "password", label: "Password (Gen1 only)", secret: true },
  ],
  async read(config) {
    const base = `http://${host(config.host)}`, channel = Number(config.channel || 0);
    try {
      const status = await (await request(`${base}/rpc/Switch.GetStatus?id=${channel}`)).json();
      return { powerW: watts(status.apower), on: typeof status.output === "boolean" ? status.output : null };
    } catch {
      const status = await (await request(`${base}/status`, { headers: shellyGen1Headers(config) })).json();
      const meter = status.meters?.[channel] ?? status.emeters?.[channel];
      return { powerW: watts(meter?.power), on: typeof status.relays?.[channel]?.ison === "boolean" ? status.relays[channel].ison : null };
    }
  },
  async switch(config, on) {
    const base = `http://${host(config.host)}`, channel = Number(config.channel || 0);
    try {
      await request(`${base}/rpc/Switch.Set?id=${channel}&on=${on}`);
    } catch {
      await request(`${base}/relay/${channel}?turn=${on ? "on" : "off"}`, { headers: shellyGen1Headers(config) });
    }
  },
};

const tasmota: Driver = {
  id: "tasmota",
  name: "Tasmota",
  description: "Plugs flashed with Tasmota (Sonoff, Athom, Nous and others).",
  fields: [
    { key: "host", label: "IP address", required: true, placeholder: "192.168.1.60" },
    { key: "username", label: "Web user", help: "Only when a web password is set on the device." },
    { key: "password", label: "Web password", secret: true },
  ],
  async read(config) {
    const query = new URLSearchParams({ cmnd: "Status 8" });
    if (config.password) { query.set("user", config.username || "admin"); query.set("password", config.password); }
    const status = await (await request(`http://${host(config.host)}/cm?${query}`)).json();
    const energy = status.StatusSNS?.ENERGY;
    if (!energy) throw Error("This Tasmota device has no energy meter");
    return { powerW: watts(Array.isArray(energy.Power) ? energy.Power.reduce((sum: number, value: number) => sum + value, 0) : energy.Power), on: null };
  },
};

function homeAssistantUrl(config: Config) {
  const url = config.url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/.test(url)) throw Error("Enter the Home Assistant URL, starting with http:// or https://");
  return url;
}
function entityId(id: string) {
  if (!/^\w+\.\w+$/.test(id)) throw Error("Enter an entity ID such as sensor.plug_power");
  return id;
}
const homeAssistant: Driver = {
  id: "homeassistant",
  name: "Home Assistant",
  description: "Any power sensor in Home Assistant, read through its REST API with a long-lived access token.",
  fields: [
    { key: "url", label: "Home Assistant URL", required: true, placeholder: "http://192.168.1.10:8123" },
    { key: "token", label: "Long-lived access token", secret: true, required: true, help: "Create it in your Home Assistant profile, under Security." },
    { key: "entity", label: "Power sensor entity", required: true, placeholder: "sensor.plug_power" },
    { key: "switch", label: "Switch entity", placeholder: "switch.plug", help: "Optional, to show whether the plug is on and to switch it." },
  ],
  async read(config) {
    const url = homeAssistantUrl(config);
    const entity = (id: string) =>
      request(`${url}/api/states/${entityId(id)}`, { headers: { Authorization: `Bearer ${config.token}` } }).then((response) => response.json());
    const state = await entity(config.entity.trim());
    const unit = String(state.attributes?.unit_of_measurement || "W");
    const power = watts(state.state) * (unit === "kW" ? 1000 : unit === "mW" ? 0.001 : 1);
    const toggle = config.switch?.trim() ? await entity(config.switch.trim()).catch(() => null) : null;
    return { powerW: power, on: toggle ? toggle.state === "on" : null };
  },
  switchable: (config) => Boolean(config.switch?.trim()),
  async switch(config, on) {
    const body = Buffer.from(JSON.stringify({ entity_id: entityId(config.switch?.trim() || "") }));
    await request(`${homeAssistantUrl(config)}/api/services/homeassistant/turn_${on ? "on" : "off"}`, { method: "POST", headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" }, body });
  },
};

export const DRIVERS: Driver[] = [tapo, shelly, tasmota, homeAssistant];

export type PowerDevice = { id: string; name: string; driver: string; enabled: boolean; config: Config };
type Sample = { at: number; w: number };
type Hour = { at: number; wh: number; maxW: number };
type DeviceState = { recent: Sample[]; hourly: Hour[]; lastAt?: number; lastW?: number; on?: boolean | null; error?: string; errorAt?: number };
export type PowerSettings = { pricePerKwh: number; currency: string };

export const powerDevices = () => read<PowerDevice[]>("power-devices", []);
export const powerSettings = (): PowerSettings => ({ pricePerKwh: 0, currency: "lei", ...read<Partial<PowerSettings>>("power-settings", {}) });
const powerState = () => read<Record<string, DeviceState>>("power", {});

// Secrets never leave the server: the browser sees only whether one is set.
export function publicDevices() {
  const state = powerState();
  return powerDevices().map((device) => {
    const driver = DRIVERS.find((item) => item.id === device.driver);
    const config = Object.fromEntries(Object.entries(device.config).map(([key, value]) =>
      [key, driver?.fields.find((field) => field.key === key)?.secret ? (value ? "••••••••" : "") : value]));
    const live = state[device.id];
    const canSwitch = Boolean(driver?.switch) && (driver?.switchable?.(device.config) ?? true);
    return { ...device, config, canSwitch, status: live ? { at: live.lastAt ?? null, powerW: live.lastW ?? null, on: live.on ?? null, error: live.error ?? null } : null };
  });
}

export async function savePowerDevice(input: Record<string, unknown>) {
  const driver = DRIVERS.find((item) => item.id === input.driver);
  if (!driver) throw Error("Choose a device type");
  const name = String(input.name || "").trim().slice(0, 60);
  if (!name) throw Error("Enter a name");
  const all = powerDevices();
  const id = typeof input.id === "string" && all.some((device) => device.id === input.id) ? input.id : randomUUID();
  const previous = all.find((device) => device.id === id);
  const config: Config = {};
  for (const field of driver.fields) {
    let value = String(input[field.key] ?? "").trim().slice(0, 500);
    // A secret left blank or unchanged keeps the stored one.
    if (field.secret && (!value || value === "••••••••")) value = previous?.driver === driver.id ? previous.config[field.key] || "" : "";
    if (field.required && !value) throw Error(`Enter ${field.label.toLowerCase()}`);
    config[field.key] = value;
  }
  const device: PowerDevice = { id, name, driver: driver.id, enabled: input.enabled !== false && input.enabled !== "false", config };
  const reading = await driver.read(config);
  save("power-devices", [...all.filter((item) => item.id !== id), device]);
  recordReading(id, reading, Date.now());
  audit(`power device saved ${name} (${driver.id})`);
  return reading;
}

// Switches a device's relay, then reads it again so the page shows the new
// state and power at once. Everything behind the device loses power when it
// is turned off; the page asks before doing that.
export async function switchPowerDevice(id: string, on: boolean) {
  const device = powerDevices().find((item) => item.id === id);
  if (!device) throw Error("Device not found");
  const driver = DRIVERS.find((item) => item.id === device.driver);
  if (!driver?.switch || driver.switchable?.(device.config) === false) throw Error("This device cannot be switched from the dashboard");
  await driver.switch(device.config, on);
  audit(`power device ${device.name} switched ${on ? "on" : "off"}`);
  try {
    recordReading(id, await driver.read(device.config), Date.now());
  } catch {
    // The switch itself succeeded; the next minute's reading reports the state.
  }
  return { on };
}

export function deletePowerDevice(id: string) {
  const all = powerDevices();
  const device = all.find((item) => item.id === id);
  if (!device) throw Error("Device not found");
  save("power-devices", all.filter((item) => item.id !== id));
  const state = powerState();
  delete state[id];
  save("power", state, false);
  audit(`power device deleted ${device.name}`);
}

export function savePowerSettings(input: Record<string, unknown>) {
  const pricePerKwh = Number(input.pricePerKwh);
  if (!Number.isFinite(pricePerKwh) || pricePerKwh < 0 || pricePerKwh > 1000) throw Error("Enter a price per kWh");
  const currency = String(input.currency || "lei").trim().slice(0, 8) || "lei";
  save("power-settings", { pricePerKwh, currency });
}

const RECENT_MS = 48 * 3600000;
const MAX_GAP_MS = 10 * 60000;
const HOUR = 3600000;
// Adds a reading and integrates the energy since the previous one (trapezoid),
// unless the gap is too long to assume the power was steady in between.
export function recordReading(id: string, reading: PowerReading, at: number, states = powerState()) {
  const state = states[id] ?? { recent: [], hourly: [] };
  const previous = state.recent.at(-1);
  if (previous && at > previous.at && at - previous.at <= MAX_GAP_MS) {
    const hourAt = Math.floor(at / HOUR) * HOUR;
    let hour = state.hourly.at(-1);
    if (!hour || hour.at !== hourAt) state.hourly.push((hour = { at: hourAt, wh: 0, maxW: 0 }));
    hour.wh += ((previous.w + reading.powerW) / 2) * ((at - previous.at) / HOUR);
    hour.maxW = Math.max(hour.maxW, reading.powerW);
  }
  state.recent = [...state.recent.filter((sample) => sample.at > at - RECENT_MS), { at, w: reading.powerW }];
  const retention = serverSettings().metricsRetentionDays * 86400000;
  state.hourly = state.hourly.filter((hour) => hour.at > at - retention);
  Object.assign(state, { lastAt: at, lastW: reading.powerW, on: reading.on, error: undefined, errorAt: undefined });
  states[id] = state;
  save("power", states, false);
  return state;
}

// Reads every enabled device once; called every minute by the background monitor.
export async function samplePower() {
  const devices = powerDevices().filter((device) => device.enabled);
  if (!devices.length) return;
  const results = await Promise.all(devices.map(async (device) => {
    const driver = DRIVERS.find((item) => item.id === device.driver);
    try {
      if (!driver) throw Error("Unknown device type");
      return { device, reading: await driver.read(device.config) };
    } catch (error) {
      return { device, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  const states = powerState(), now = Date.now();
  for (const result of results) {
    // Announce changes only: a device that was failing and reads again, or the reverse.
    const wasFailing = Boolean(states[result.device.id]?.error);
    if (result.reading) {
      if (wasFailing) emitDashboardEvent({ type: "power-online", severity: "success", title: `${result.device.name} is responding again`, message: `Current power ${Math.round(result.reading.powerW)} W.` });
      recordReading(result.device.id, result.reading, now, states);
    } else {
      if (!wasFailing) emitDashboardEvent({ type: "power-offline", severity: "warning", title: `${result.device.name} stopped responding`, message: result.error ?? "The device could not be read." });
      states[result.device.id] = { ...(states[result.device.id] ?? { recent: [], hourly: [] }), error: result.error, errorAt: now };
      save("power", states, false);
    }
  }
}

// Power over the range (1-minute samples for 24 hours, hourly averages beyond)
// and the energy per hour, for the charts; the browser groups hours into days.
export function powerHistory(range: "24h" | "7d" | "30d") {
  const span = { "24h": 24 * HOUR, "7d": 7 * 24 * HOUR, "30d": 30 * 24 * HOUR }[range];
  const now = Date.now(), from = now - span, state = powerState();
  const devices = powerDevices().map((device) => ({ id: device.id, name: device.name }));
  const power = devices.map((device) => {
    const live = state[device.id];
    const points = range === "24h"
      ? (live?.recent ?? []).filter((sample) => sample.at >= from).map((sample) => ({ at: sample.at, w: sample.w }))
      // An hour's energy in Wh equals its average power in W, so only
      // completed hours are shown; the current one would read too low.
      : (live?.hourly ?? []).filter((hour) => hour.at >= from && hour.at + HOUR <= now).map((hour) => ({ at: hour.at + HOUR / 2, w: hour.wh }));
    return { id: device.id, points };
  });
  const energy = devices.map((device) => ({ id: device.id, hours: (state[device.id]?.hourly ?? []).filter((hour) => hour.at >= now - 31 * 24 * HOUR).map((hour) => ({ at: hour.at, wh: hour.wh })) }));
  return { range, from, to: now, devices, power, energy, settings: powerSettings() };
}
