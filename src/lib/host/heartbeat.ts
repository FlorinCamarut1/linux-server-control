// Telling the outside world whether the server is well. Two things, both
// driven by the background monitor:
// - A server that stops answering the dashboard is announced on the
//   notification channels, and again once it answers.
// - A heartbeat: an address the dashboard calls after every reading of the
//   server that worked. The dashboard usually runs on the server it manages,
//   so when that server goes down nothing is left to send a notification; a
//   monitoring service that expects the call (healthchecks.io, Uptime Kuma)
//   notices that it stopped coming and raises the alarm itself.
import { audit, emitDashboardEvent, read, save } from "./store";
import { t } from "../i18n";

// One failed reading may be a restart of the server or of its SSH service; the
// second in a row, five minutes later, is announced.
const UNREACHABLE_AFTER = 2;
// Kept in DATA_DIR, so a restart of the dashboard neither announces the same
// outage again nor misses saying that the server answers again.
type HostStatus = { failures: number; since?: number; announced?: boolean };
const hostStatus = () => read<HostStatus>("host-status", { failures: 0 });
const minutesSince = (since: number | undefined, now: number) => Math.max(1, Math.round((now - (since ?? now)) / 60000));
export function hostUnreachable(reason: string, now = Date.now()) {
  const status = hostStatus();
  const next: HostStatus = { ...status, failures: status.failures + 1, since: status.since ?? now };
  if (next.failures >= UNREACHABLE_AFTER && !next.announced) {
    next.announced = true;
    audit("server unreachable: " + reason);
    emitDashboardEvent(() => ({
      type: "server-unreachable", severity: "critical", title: t("The server does not answer"),
      message: t("The dashboard could not read the server for {minutes} min: {error}", { minutes: minutesSince(next.since, now), error: reason }),
    }));
  }
  save("host-status", next);
}
export function hostReachable(now = Date.now()) {
  const status = hostStatus();
  if (!status.failures) return;
  if (status.announced) {
    audit("server reachable again");
    emitDashboardEvent(() => ({
      type: "server-unreachable", severity: "success", title: t("The server answers again"),
      message: t("It did not answer the dashboard for {minutes} min.", { minutes: minutesSince(status.since, now) }),
    }));
  }
  save("host-status", { failures: 0 });
}

// The address holds the check's secret, so the browser is shown only its host.
type Heartbeat = { url?: string; lastPingAt?: number; lastError?: string };
const stored = () => read<Heartbeat>("heartbeat", {});
export function heartbeatState() {
  const { url, lastPingAt, lastError } = stored();
  let host = "";
  try { host = url ? new URL(url).host : ""; } catch {}
  return { set: Boolean(url), host, lastPingAt: lastPingAt ?? null, lastError: lastError ?? null };
}
// An empty address turns the heartbeat off.
export function saveHeartbeat(input: Record<string, unknown>) {
  const value = String(input.url ?? "").trim();
  if (!value) {
    save("heartbeat", {});
    audit("heartbeat removed");
    return;
  }
  let url: URL;
  try { url = new URL(value); } catch { throw Error(t("Enter the address the monitoring service gave you")); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw Error(t("The address must start with https:// or http://"));
  save("heartbeat", { url: url.toString() });
  audit(`heartbeat set (${url.host})`);
}
// Calls the address now and records how it went; fails when it did not work.
export async function pingHeartbeat() {
  const { url } = stored();
  if (!url) throw Error(t("No heartbeat address is set"));
  let problem = "";
  try {
    const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(10000), cache: "no-store" });
    if (!response.ok) problem = t("The address answered HTTP {status}", { status: response.status });
  } catch {
    problem = t("The address could not be reached");
  }
  // The address may have been changed or removed while it was being called.
  if (stored().url === url) save("heartbeat", { url, lastPingAt: Date.now(), ...(problem ? { lastError: problem } : {}) });
  if (problem) throw Error(problem);
}
// For the background monitor: a failed call is recorded, and tried again at
// the next reading.
export async function sendHeartbeat() {
  if (stored().url) await pingHeartbeat().catch(() => {});
}
