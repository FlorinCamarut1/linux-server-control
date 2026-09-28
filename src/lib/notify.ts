import { randomUUID } from "node:crypto";
import { EVENT_TYPES, audit, read, save, serverSettings, type DashboardEvent, type EventType } from "./server";

// Notification channels: webhooks that receive dashboard events. Each type
// formats the same event for its service.

type ChannelType = "discord" | "slack" | "ntfy" | "webhook";
export type Channel = { id: string; name: string; type: ChannelType; url: string; events: EventType[]; enabled: boolean; lastSentAt?: number; lastError?: string };

export const CHANNEL_TYPES: { id: ChannelType; name: string; placeholder: string; help: string }[] = [
  { id: "discord", name: "Discord", placeholder: "https://discord.com/api/webhooks/…", help: "Channel settings > Integrations > Webhooks > New webhook > Copy URL." },
  { id: "slack", name: "Slack, Mattermost or Rocket.Chat", placeholder: "https://hooks.slack.com/services/…", help: "An incoming webhook URL; the Slack message format is also accepted by Mattermost and Rocket.Chat." },
  { id: "ntfy", name: "ntfy", placeholder: "https://ntfy.sh/your-topic", help: "The topic URL on ntfy.sh or your own ntfy server; subscribe to the topic in the ntfy app." },
  { id: "webhook", name: "Generic JSON webhook", placeholder: "https://example.com/hooks/dashboard", help: "Receives a JSON POST with event, severity, title, message, host and time; for Home Assistant, n8n or your own scripts." },
];

const COLORS = { info: 0x2a78d6, warning: 0xfab219, critical: 0xd03b3b, success: 0x0ca30c };
const NTFY = { info: ["3", "information_source"], warning: ["4", "warning"], critical: ["5", "rotating_light"], success: ["3", "white_check_mark"] };

const channels = () => read<Channel[]>("notification-channels", []);
const host = () => serverSettings().sshTarget.split("@").pop() || "local server";

async function send(channel: Pick<Channel, "type" | "url">, event: DashboardEvent) {
  const origin = host();
  let init: RequestInit;
  if (channel.type === "discord")
    init = { headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "Linux Server Control", embeds: [{ title: event.title, description: event.message, color: COLORS[event.severity], footer: { text: origin }, timestamp: new Date().toISOString() }] }) };
  else if (channel.type === "slack")
    init = { headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `*${event.title}*\n${event.message}\n_${origin}_` }) };
  else if (channel.type === "ntfy") {
    const [priority, tag] = NTFY[event.severity];
    // Header values must be plain ASCII; the full title is repeated in the body.
    init = { headers: { Title: event.title.replace(/[^\x20-\x7e]/g, "?"), Priority: priority, Tags: tag }, body: `${event.message}\n${origin}` };
  } else
    init = { headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "linux-server-control", host: origin, event: event.type, severity: event.severity, title: event.title, message: event.message, at: new Date().toISOString() }) };
  const response = await fetch(channel.url, { ...init, method: "POST", signal: AbortSignal.timeout(10000), cache: "no-store" });
  if (!response.ok) throw Error(`The webhook answered HTTP ${response.status}`);
}

function record(id: string, result: { error?: string }) {
  save("notification-channels", channels().map((channel) => channel.id === id
    ? { ...channel, lastSentAt: Date.now(), lastError: result.error }
    : channel));
}

// Sends an event to every enabled channel subscribed to it. Failures are
// recorded on the channel and never interrupt the caller.
export async function deliver(event: DashboardEvent) {
  const targets = channels().filter((channel) => channel.enabled && channel.events.includes(event.type));
  await Promise.all(targets.map(async (channel) => {
    try {
      await send(channel, event);
      record(channel.id, {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Notification to ${channel.name} failed:`, message);
      record(channel.id, { error: message });
    }
  }));
}

// Webhook URLs contain the credentials, so the browser only sees their host.
export function publicChannels() {
  return channels().map((channel) => {
    let shown = "";
    try { shown = new URL(channel.url).host; } catch {}
    return { ...channel, url: shown };
  });
}

function validUrl(type: ChannelType, value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw Error("Enter the webhook URL"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw Error("The webhook URL must start with https:// or http://");
  if (type === "discord" && !(/(^|\.)discord(app)?\.com$/.test(url.hostname) && url.pathname.startsWith("/api/webhooks/")))
    throw Error("A Discord webhook URL starts with https://discord.com/api/webhooks/");
  return url.toString();
}

export function saveChannel(input: Record<string, unknown>) {
  const type = CHANNEL_TYPES.find((item) => item.id === input.type)?.id;
  if (!type) throw Error("Choose a channel type");
  const name = String(input.name || "").trim().slice(0, 60);
  if (!name) throw Error("Enter a name");
  const all = channels();
  const previous = all.find((channel) => channel.id === input.id);
  const rawUrl = String(input.url || "").trim();
  // Editing without a new URL keeps the stored one.
  const url = rawUrl ? validUrl(type, rawUrl) : previous?.type === type ? previous.url : validUrl(type, "");
  const requested = Array.isArray(input.events) ? input.events : String(input.events || "").split(",");
  const events = (Object.keys(EVENT_TYPES) as EventType[]).filter((event) => requested.includes(event));
  if (!events.length) throw Error("Choose at least one event");
  const channel: Channel = { id: previous?.id ?? randomUUID(), name, type, url, events, enabled: input.enabled !== false && input.enabled !== "false", lastSentAt: previous?.lastSentAt, lastError: previous?.lastError };
  save("notification-channels", [...all.filter((item) => item.id !== channel.id), channel]);
  audit(`notification channel saved ${name} (${type})`);
}

export function deleteChannel(id: string) {
  const all = channels();
  const channel = all.find((item) => item.id === id);
  if (!channel) throw Error("Channel not found");
  save("notification-channels", all.filter((item) => item.id !== id));
  audit(`notification channel deleted ${channel.name}`);
}

// Sends a test message and reports the result directly, unlike deliver.
export async function testChannel(id: string) {
  const channel = channels().find((item) => item.id === id);
  if (!channel) throw Error("Channel not found");
  try {
    await send(channel, { type: "alert", severity: "info", title: "Test notification", message: `Notifications from Linux Server Control reach ${channel.name}.` });
    record(channel.id, {});
  } catch (error) {
    record(channel.id, { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
