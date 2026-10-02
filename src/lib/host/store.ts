// Dashboard data in DATA_DIR: JSON records, sessions, the audit log, the event
// bus and the credential helpers. Nothing here talks to the managed server.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
export const DATA = process.env.DATA_DIR || "/app/data";
// `next build` also loads this module, on machines where DATA_DIR may not be
// creatable; a missing folder then surfaces on the first write instead.
try { mkdirSync(DATA, { recursive: true }); } catch {}
// user is absent in sessions created before accounts existed; they belong to the owner.
export type Session = { device: string; expires: number; created: number; user?: string };
export const sessions = new Map<string, Session>();
// Parsed records are cached per file identity (modification time, size and
// inode): a refresh reads a dozen records, several of them more than once, and
// only re-parses those another writer has replaced since. Callers that change a
// returned record save it afterwards, which replaces the file.
const recordCache = new Map<string, { stamp: string; value: unknown }>();
export function read<T>(name: string, fallback: T): T {
  const file = path.join(DATA, name + ".json");
  try {
    const { mtimeMs, size, ino } = statSync(file);
    const stamp = `${mtimeMs}:${size}:${ino}`;
    const cached = recordCache.get(name);
    if (cached?.stamp === stamp) return cached.value as T;
    const value = JSON.parse(readFileSync(file, "utf8"));
    recordCache.set(name, { stamp, value });
    return value;
  } catch {
    return fallback;
  }
}
export function save(name: string, value: unknown, pretty = true) {
  const p = path.join(DATA, name + ".json"),
    t = p + ".tmp";
  writeFileSync(t, JSON.stringify(value, null, pretty ? 2 : undefined), { mode: 0o600 });
  renameSync(t, p);
}
export function loadSessions() {
  const stored = read<Record<string, Session>>("sessions", {});
  const now = Date.now();
  for (const [id, session] of Object.entries(stored))
    if (session.expires > now) sessions.set(id, session);
}
export function persistSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) if (session.expires <= now) sessions.delete(id);
  save("sessions", Object.fromEntries(sessions));
}
// Events that notification channels can deliver. Listeners live on globalThis
// because Next.js loads this module separately for the API routes and for the
// background monitor; both must reach the same listeners.
export const EVENT_TYPES = {
  alert: "Alert triggered",
  "script-failed": "Script run failed",
  "cron-failed": "Scheduled run failed",
  "power-offline": "Power device stopped responding",
  "power-online": "Power device responding again",
} as const;
export type EventType = keyof typeof EVENT_TYPES;
export type DashboardEvent = { type: EventType; title: string; message: string; severity: "info" | "warning" | "critical" | "success" };
type EventListener = (event: DashboardEvent) => void;
const eventBus = globalThis as { lscEventListeners?: EventListener[] };
export function onDashboardEvent(listener: EventListener) {
  (eventBus.lscEventListeners ??= []).push(listener);
}
export function emitDashboardEvent(event: DashboardEvent) {
  for (const listener of eventBus.lscEventListeners ?? []) {
    try { listener(event); } catch (error) { console.error("Event listener failed:", error); }
  }
}
// The one-time token that authorizes initial setup. It is printed to the
// container log on every start until setup is completed.
export function announceSetupToken() {
  if (read<{ password?: string }>("config", {}).password) return;
  let code = read<{ code?: string }>("setup-bootstrap", {}).code;
  if (!code) {
    code = randomBytes(12).toString("base64url");
    save("setup-bootstrap", { code });
  }
  console.log(`\nInitial setup token: ${code}\n`);
}
export function hash(password: string, salt: string) {
  return new Promise<string>((resolve, reject) =>
    scrypt(password, Buffer.from(salt, "hex"), 64, { N: 16384, r: 8, p: 1 }, (error, key) =>
      error ? reject(error) : resolve(key.toString("hex"))));
}
export function secureEqual(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function digest(x: string) {
  return createHash("sha256").update(x).digest("hex");
}
export function token() {
  return randomBytes(32).toString("base64url");
}
// The account whose request is being handled, so every audited action names
// who performed it. Kept on globalThis for the same reason as the event bus.
const actor = ((globalThis as { lscActor?: AsyncLocalStorage<string> }).lscActor ??= new AsyncLocalStorage<string>());
export function asActor<T>(name: string, work: () => T) {
  return actor.run(name, work);
}
const MAX_AUDIT_LOG_BYTES = 5 * 1024 * 1024;
// One previous file is kept, so the audit trail never exceeds about 10 MB.
// Lines written while handling a request start with the account in brackets;
// the background monitor's lines have none.
export function audit(x: string) {
  const file = path.join(DATA, "audit.log");
  try {
    if (statSync(file).size > MAX_AUDIT_LOG_BYTES) renameSync(file, file + ".1");
  } catch {}
  const account = actor.getStore();
  appendFileSync(
    file,
    new Date().toISOString() + " " + (account ? `[${account}] ` : "") + x + "\n",
  );
}
// Sessions are intentionally persisted without credentials so routine restarts do not sign out every browser.
loadSessions();
