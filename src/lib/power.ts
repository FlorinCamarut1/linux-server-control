import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { audit, read, save, serverSettings } from "./server";

// Smart plugs and energy meters. Each device model is a driver: the fields
// its settings form needs, and how to read the current power. Readings are
// taken every minute; energy is the power integrated over time, the same way
// for every driver.

export type PowerReading = { powerW: number; on: boolean | null };
export type DriverField = { key: string; label: string; secret?: boolean; required?: boolean; placeholder?: string; help?: string };
type Config = Record<string, string>;
export type Driver = { id: string; name: string; description: string; fields: DriverField[]; read(config: Config): Promise<PowerReading> };

const TIMEOUT_MS = 8000;
async function request(url: string, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  if (!response.ok) throw Error(`The device answered HTTP ${response.status}`);
  return response;
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
    const first = await request(`${this.base}/app/handshake1`, { method: "POST", body: new Uint8Array(localSeed) });
    this.cookie = (first.headers.get("set-cookie") || "").split(";")[0];
    const reply = Buffer.from(await first.arrayBuffer());
    const remoteSeed = reply.subarray(0, 16);
    if (reply.length < 48 || !sha256(localSeed, remoteSeed, this.auth).equals(reply.subarray(16, 48)))
      throw Error("The Tapo account email or password is not accepted by the plug");
    await request(`${this.base}/app/handshake2`, { method: "POST", headers: { Cookie: this.cookie }, body: new Uint8Array(sha256(remoteSeed, localSeed, this.auth)) });
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
  async call(method: string) {
    this.seq = this.seq === 0x7fffffff ? -0x80000000 : this.seq + 1;
    const { iv, counter } = this.iv(this.seq);
    const cipher = createCipheriv("aes-128-cbc", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify({ method })), cipher.final()]);
    const body = Buffer.concat([sha256(this.signature, counter, encrypted), encrypted]);
    const response = await request(`${this.base}/app/request?seq=${this.seq}`, { method: "POST", headers: { Cookie: this.cookie }, body: new Uint8Array(body) });
    const decipher = createDecipheriv("aes-128-cbc", this.key, iv);
    const payload = Buffer.from(await response.arrayBuffer()).subarray(32);
    const result = JSON.parse(Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8"));
    if (result.error_code !== 0) throw Error(`The plug returned error ${result.error_code}`);
    return result.result;
  }
}
const tapo: Driver = {
  id: "tapo",
  name: "TP-Link Tapo (P110, P115)",
  description: "Read directly on the LAN with the Tapo account used in the Tapo app.",
  fields: [
    { key: "host", label: "IP address", required: true, placeholder: "192.168.1.144" },
    { key: "username", label: "Tapo account email", required: true },
    { key: "password", label: "Tapo account password", secret: true, required: true },
  ],
  async read(config) {
    const session = new KlapSession(`http://${host(config.host)}`, KlapSession.authHash(config.username.trim(), config.password));
    await session.handshake();
    const energy = await session.call("get_energy_usage");
    const info = await session.call("get_device_info").catch(() => null);
    // get_energy_usage reports current_power in milliwatts.
    return { powerW: watts(energy?.current_power) / 1000, on: typeof info?.device_on === "boolean" ? info.device_on : null };
  },
};

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
      const headers: Record<string, string> = config.username ? { Authorization: `Basic ${Buffer.from(`${config.username}:${config.password || ""}`).toString("base64")}` } : {};
      const status = await (await request(`${base}/status`, { headers })).json();
      const meter = status.meters?.[channel] ?? status.emeters?.[channel];
      return { powerW: watts(meter?.power), on: typeof status.relays?.[channel]?.ison === "boolean" ? status.relays[channel].ison : null };
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

const homeAssistant: Driver = {
  id: "homeassistant",
  name: "Home Assistant",
  description: "Any power sensor in Home Assistant, read through its REST API with a long-lived access token.",
  fields: [
    { key: "url", label: "Home Assistant URL", required: true, placeholder: "http://192.168.1.10:8123" },
    { key: "token", label: "Long-lived access token", secret: true, required: true, help: "Create it in your Home Assistant profile, under Security." },
    { key: "entity", label: "Power sensor entity", required: true, placeholder: "sensor.plug_power" },
    { key: "switch", label: "Switch entity", placeholder: "switch.plug", help: "Optional, to show whether the plug is on." },
  ],
  async read(config) {
    const url = config.url.trim().replace(/\/+$/, "");
    if (!/^https?:\/\/[^\s/]+/.test(url)) throw Error("Enter the Home Assistant URL, starting with http:// or https://");
    const entity = (id: string) => {
      if (!/^\w+\.\w+$/.test(id)) throw Error("Enter an entity ID such as sensor.plug_power");
      return request(`${url}/api/states/${id}`, { headers: { Authorization: `Bearer ${config.token}` } }).then((response) => response.json());
    };
    const state = await entity(config.entity.trim());
    const unit = String(state.attributes?.unit_of_measurement || "W");
    const power = watts(state.state) * (unit === "kW" ? 1000 : unit === "mW" ? 0.001 : 1);
    const toggle = config.switch?.trim() ? await entity(config.switch.trim()).catch(() => null) : null;
    return { powerW: power, on: toggle ? toggle.state === "on" : null };
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
    return { ...device, config, status: live ? { at: live.lastAt ?? null, powerW: live.lastW ?? null, on: live.on ?? null, error: live.error ?? null } : null };
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
    if (result.reading) recordReading(result.device.id, result.reading, now, states);
    else {
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
