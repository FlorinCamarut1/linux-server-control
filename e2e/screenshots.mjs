// Takes the pictures in docs/screenshots from a demonstration instance: made-up
// containers, scripts, plugs and a month of samples, with the demo folder
// mounted at /srv, so that no real path, name, address or token is shown.
//
//   npm run build && npm run screenshots
//
// With a folder as argument (npm run screenshots -- /tmp/review) the pictures
// go there instead, together with every page at phone width: a way to look
// over the whole interface after changing it, without touching the docs.
//
// Needs bubblewrap (bwrap) for the /srv mount and Playwright's Chromium.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const standalone = path.join(root, ".next", "standalone");
if (!existsSync(path.join(standalone, "server.js"))) {
  console.error("No production build found. Run `npm run build` first.");
  process.exit(1);
}
if (spawnSync("bwrap", ["--version"]).status !== 0) {
  console.error("bubblewrap (bwrap) is needed to mount the demo folder at /srv.");
  process.exit(1);
}
const tmp = path.join(root, "e2e", ".tmp", "demo");
const app = path.join(tmp, "app"), data = path.join(tmp, "data"), srv = path.join(tmp, "srv"), bin = path.join(tmp, "bin");
const review = process.argv[2] ? path.resolve(process.argv[2]) : null;
const out = review ?? path.join(root, "docs", "screenshots");
const PAGES = ["Overview", "Containers", "Scripts", "Files", "Schedules", "Power", "History", "Alerts", "Settings"];
const PORT = 3220, BASE = `http://127.0.0.1:${PORT}`;
const PLUGS = { rack: 3221, network: 3222, nas: 3223 };
const USERNAME = "admin", PASSWORD = "demonstration-password";
const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

rmSync(tmp, { recursive: true, force: true });
cpSync(standalone, app, { recursive: true, filter: (source) => ![".env", "data"].includes(path.relative(standalone, source)) });
cpSync(path.join(root, ".next", "static"), path.join(app, ".next", "static"), { recursive: true });
for (const folder of [data, bin, out]) mkdirSync(folder, { recursive: true });

// The same numbers on every run, so the pictures only change when the page does.
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
// How busy a home server is over the day, from 0 at night to 1 in the evening.
function activity(at) {
  const date = new Date(at), hour = date.getHours() + date.getMinutes() / 60;
  return 0.5 - 0.5 * Math.cos(((hour - 4) / 24) * 2 * Math.PI);
}

// The folder mounted at /srv: scripts to run and a media library to browse.
// The media files are sparse: they have a size but take no space.
function file(name, content, mode = 0o644) {
  const target = path.join(srv, name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, { mode });
}
function media(name, gigabytes) {
  file(name, "");
  truncateSync(path.join(srv, name), Math.round(gigabytes * 1024 ** 3));
}
const script = (lines) => `#!/usr/bin/env bash\nset -eu\n\n${lines.join("\n")}\n`;
file("scripts/backup-library.sh", script(['echo "Backing up the library index to /srv/backups"', "sleep 1", 'echo "1,284 items saved"']), 0o755);
file("scripts/clean-downloads.sh", script(['echo "Removing downloads older than 30 days"', 'echo "Nothing to remove"']), 0o755);
file("scripts/maintenance/sync-vpn-port.sh", script(['echo "Asking the VPN for its forwarded port"', 'echo "error: the VPN did not answer" >&2', "exit 1"]), 0o755);
file("scripts/maintenance/update-containers.sh", script(['echo "Pulling new images"', 'echo "All containers are up to date"']), 0o755);
file("scripts/maintenance/rebuild-index.sh", script(['echo "Rebuilding the search index"', 'for part in 1 2 3; do echo "Indexed part $part of 40"; done', "sleep 300"]), 0o755);
for (const [name, size] of [["Big Buck Bunny (2008).mkv", 4.2], ["Sintel (2010).mkv", 6.8], ["Tears of Steel (2012).mkv", 9.1], ["Elephants Dream (2006).mkv", 3.4]]) media(`media/movies/${name}`, size);
for (let episode = 1; episode <= 6; episode++) media(`media/shows/Caminandes/Season 01/Caminandes S01E0${episode}.mkv`, 1.4);
for (const [name, size] of [["Open Goldberg Variations.flac", 0.4], ["Kimiko Ishizaka - Well-Tempered Clavier.flac", 0.9]]) media(`media/music/${name}`, size);
media("media/downloads/ubuntu-26.04-live-server-amd64.iso", 3.1);
file("media/library-notes.txt", "Movies and shows are organised by Jellyfin.\nDownloads are cleaned every 30 days.\n");
for (const folder of ["backups", "logs"]) mkdirSync(path.join(srv, folder), { recursive: true });

// Stand-ins, first in the server's PATH: Docker with a media stack, a crontab
// kept in a file, and disks with made-up sizes.
const container = (ID, Names, Image, Status, Ports, Mounts, State = "running") =>
  JSON.stringify({ ID, Names, Image, State, Status, Ports, Mounts, CreatedAt: "2026-09-20 08:12:04 +0300 EEST", Networks: Names === "gluetun" || !Ports ? "vpn" : "media", Labels: "" });
writeFileSync(path.join(tmp, "containers.jsonl"), [
  container("3f1c2a9b7d01", "jellyfin", "lscr.io/linuxserver/jellyfin:latest", "Up 3 days (healthy)", "0.0.0.0:8096->8096/tcp, [::]:8096->8096/tcp, 0.0.0.0:7359->7359/udp", "/srv/media,/srv/config/jellyfin"),
  container("8a2d4c6e1f03", "jellyseerr", "ghcr.io/seerr-team/seerr:latest", "Up 3 days", "0.0.0.0:5055->5055/tcp", "/srv/config/jellyseerr"),
  container("b7e9d1a3c502", "gluetun", "qmcgaw/gluetun:latest", "Up 3 days (healthy)", "0.0.0.0:7878->7878/tcp, 0.0.0.0:8989->8989/tcp, 0.0.0.0:8080->8080/tcp, 0.0.0.0:9696->9696/tcp", "/srv/config/gluetun"),
  container("c4f8a2b6d904", "radarr", "lscr.io/linuxserver/radarr:latest", "Up 3 days", "", "/srv/media,/srv/config/radarr"),
  container("d1b5e7f9a305", "sonarr", "lscr.io/linuxserver/sonarr:latest", "Up 3 days", "", "/srv/media,/srv/config/sonarr"),
  container("e6c2a4d8b106", "qbittorrent", "lscr.io/linuxserver/qbittorrent:latest", "Up 3 days", "", "/srv/media/downloads,/srv/config/qbittorrent"),
  container("f3d7b9c1e507", "prowlarr", "lscr.io/linuxserver/prowlarr:latest", "Up 3 days", "", "/srv/config/prowlarr"),
  container("a9e1c3f5d708", "bazarr", "lscr.io/linuxserver/bazarr:latest", "Exited (0) 5 hours ago", "", "/srv/media,/srv/config/bazarr", "exited"),
].join("\n") + "\n");
writeFileSync(path.join(bin, "docker"), `#!/bin/sh
case "$1" in
  ps) case "$*" in
        *--size*) echo "412MB (virtual 1.21GB)" ;;
        *-q*) echo 3f1c2a9b7d01 ;;
        *) cat '${path.join(tmp, "containers.jsonl")}' ;;
      esac ;;
  logs) echo "2026-09-23T05:12:04.000000000Z [INF] Startup complete"; echo "2026-09-23T05:12:05.000000000Z [INF] Listening on port 8096" ;;
  start|stop|restart) echo "$2" ;;
  *) exit 64 ;;
esac
`, { mode: 0o755 });
const crontab = path.join(tmp, "crontab");
writeFileSync(crontab, "");
writeFileSync(path.join(bin, "crontab"), `#!/bin/sh
case "$1" in
  -l) cat '${crontab}' ;;
  -) cat > '${crontab}' ;;
  *) exit 64 ;;
esac
`, { mode: 0o755 });
const GIGABYTE = 1024 ** 3;
const DISKS = { "/": ["/dev/nvme0n1p2", 465, 38], "/srv/media": ["/dev/sdb1", 7452, 64], "/srv/backups": ["/dev/sdc1", 3726, 31] };
writeFileSync(path.join(bin, "df"), `#!/bin/sh
for last; do :; done
case "$last" in
${Object.entries(DISKS).map(([mount, [device, gigabytes, percent]]) => {
  const total = gigabytes * GIGABYTE, used = Math.round((total * percent) / 100);
  return `  ${mount}) printf 'Filesystem 1-blocks Used Available Capacity Mounted on\\n${device} ${total} ${used} ${total - used} ${percent}%% ${mount}\\n' ;;`;
}).join("\n")}
  *) exec /usr/bin/df "$@" ;;
esac
`, { mode: 0o755 });

// Smart plugs: a Shelly, a Tasmota plug and a Home Assistant sensor, each
// drawing a little more in the evening.
const draw = { rack: () => 34 + 22 * activity(Date.now()), network: () => 9.5 + 2 * activity(Date.now()), nas: () => 96 + 64 * activity(Date.now()) };
const json = (res, body) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
const plugs = [
  createServer((req, res) => json(res, { apower: draw.rack(), output: true })).listen(PLUGS.rack, "127.0.0.1"),
  createServer((req, res) => json(res, req.url.includes("Status") ? { StatusSNS: { ENERGY: { Power: draw.network() } } } : { POWER: "ON" })).listen(PLUGS.network, "127.0.0.1"),
  createServer((req, res) => json(res, req.url.includes("sensor.") ? { state: String(draw.nas()), attributes: { unit_of_measurement: "W" } } : { state: "on" })).listen(PLUGS.nas, "127.0.0.1"),
];
writeFileSync(path.join(data, "power-devices.json"), JSON.stringify([
  { id: "rack", name: "Server rack", driver: "shelly", enabled: true, config: { host: `127.0.0.1:${PLUGS.rack}`, channel: "", username: "", password: "" } },
  { id: "network", name: "Router and switch", driver: "tasmota", enabled: true, config: { host: `127.0.0.1:${PLUGS.network}`, username: "", password: "" } },
  { id: "nas", name: "NAS", driver: "homeassistant", enabled: true, config: { url: `http://127.0.0.1:${PLUGS.nas}`, token: "demonstration-token", entity: "sensor.nas_power", switch: "switch.nas" } },
]));
writeFileSync(path.join(data, "power-settings.json"), JSON.stringify({ pricePerKwh: 1.5, currency: "lei" }));
{
  const now = Date.now(), noise = random(7), state = {};
  for (const id of Object.keys(draw)) {
    const level = (at) => { const base = { rack: [34, 22], network: [9.5, 2], nas: [96, 64] }[id]; return base[0] + base[1] * activity(at); };
    const recent = [], hourly = [];
    for (let at = now - 48 * HOUR; at <= now - MINUTE; at += MINUTE) recent.push({ at, w: Math.max(0, level(at) * (0.94 + 0.12 * noise())) });
    for (let at = Math.floor((now - 30 * DAY) / HOUR) * HOUR; at <= now - HOUR; at += HOUR) {
      const wh = level(at + HOUR / 2) * (0.97 + 0.06 * noise());
      hourly.push({ at, wh, maxW: wh * 1.1 });
    }
    // The hour in progress has only been measured up to now.
    const started = Math.floor(now / HOUR) * HOUR;
    hourly.push({ at: started, wh: level(now) * ((now - started) / HOUR), maxW: level(now) * 1.05 });
    state[id] = { recent, hourly, lastAt: now - MINUTE, lastW: recent.at(-1).w, on: true };
  }
  writeFileSync(path.join(data, "power.json"), JSON.stringify(state));
}

// The dashboard, managing this machine directly, with the demo folder at /srv.
const server = spawn("bwrap", ["--dev-bind", "/", "/", "--bind", srv, "/srv", "--die-with-parent", "--chdir", app, process.execPath, "server.js"], {
  stdio: ["ignore", "ignore", "inherit"],
  env: {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    NODE_ENV: "production", PORT: String(PORT), HOSTNAME: "127.0.0.1",
    DATA_DIR: data, SSH_TARGET: "", SCRIPT_ROOT: "/srv/scripts", ALLOWED_PATHS: "/srv/scripts,/srv/media",
    MONITORED_PATHS: "/srv/media,/srv/backups", REMOTE_LOGS: "/srv/logs", SSH_MULTIPLEX: "false",
  },
});
function stop(code) {
  server.kill("SIGTERM");
  for (const plug of plugs) plug.close();
  process.exit(code);
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(1));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, what, timeout = 30000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline; await pause(200)) {
    try { if (await check()) return; } catch {}
  }
  throw Error(`Timed out waiting for ${what}`);
}

async function main() {
  await waitFor(async () => (await fetch(`${BASE}/api/health`)).ok, "the dashboard to start");
  const browser = await chromium.launch();
  const desktop = { viewport: { width: 1440, height: 900 }, baseURL: BASE, locale: "en-US", colorScheme: "dark" };
  const context = await browser.newContext(desktop);
  const page = await context.newPage();
  const api = context.request;
  const post = async (route, body) => {
    const response = await api.post(`/api/${route}`, { data: body });
    if (!response.ok()) throw Error(`${route}: ${(await response.json()).error}`);
    return response.json();
  };
  const get = async (route) => (await api.get(`/api/${route}`)).json();
  // The short wait lets an opening row or menu finish its transition.
  const picture = async (target, name, options = {}) => {
    await pause(350);
    await target.screenshot({ path: path.join(out, name), type: name.endsWith(".png") ? "png" : "jpeg", ...(name.endsWith(".png") ? {} : { quality: 88 }), ...options });
  };
  // On a phone the pages are in the menu of the top bar.
  const open = async (target, name) => {
    const menu = target.getByRole("button", { name: "Open the menu" });
    if (await menu.isVisible()) await menu.click();
    await target.getByRole("navigation").getByRole("button", { name, exact: true }).click();
    await target.getByRole("heading", { name, level: 1 }).waitFor();
  };

  // Setup, then everything an administrator would have added.
  const setupToken = JSON.parse(readFileSync(path.join(data, "setup-bootstrap.json"), "utf8")).code;
  await post("setup", { setupToken, username: USERNAME, password: PASSWORD, confirmPassword: PASSWORD, deviceName: "Office desktop", sshTarget: "", scriptRoot: "/srv/scripts", allowedPaths: "/srv/scripts,/srv/media", remoteLogs: "/srv/logs" });
  for (const name of ["Backups", "Maintenance"]) await post("folder/create", { name });
  for (const [name, target, folder] of [
    ["Back up library index", "backup-library.sh", "Backups"],
    ["Clean old downloads", "clean-downloads.sh", "Maintenance"],
    ["Sync VPN port", "maintenance/sync-vpn-port.sh", "Maintenance"],
    ["Update containers", "maintenance/update-containers.sh", "Maintenance"],
  ]) await post("script/save", { name, path: `/srv/scripts/${target}`, folder, runAs: "user", runOptions: "[]" });
  const scripts = Object.fromEntries((await get("state?scope=records")).scripts.map((item) => [item.name, item.id]));
  await post("schedule/save", { scriptId: scripts["Back up library index"], expression: "0 3 * * *", label: "Every day at 03:00", enabled: "true", runAs: "user" });
  await post("schedule/save", { scriptId: scripts["Sync VPN port"], expression: "*/30 * * * *", label: "Every 30 minutes", enabled: "true", runAs: "user" });
  await post("schedule/save", { scriptId: scripts["Update containers"], expression: "0 5 * * 0", label: "Every Sunday at 05:00", enabled: "false", runAs: "user" });
  await post("schedule/save", { command: "docker image prune --force", expression: "30 4 1 * *", label: "Day 1 of every month at 04:30", enabled: "true", runAs: "user" });
  for (const name of ["Update containers", "Back up library index", "Sync VPN port"]) await post("script/run", { id: scripts[name] });
  await waitFor(async () => (await get("history/runs?status=running")).total === 0, "the scripts to finish");
  for (const [name, metric, threshold, cooldownMinutes, enabled] of [
    ["Processor running hot", "temperature", 80, 30, "true"],
    ["Media disk almost full", "storage", 90, 720, "true"],
    ["System disk almost full", "disk", 85, 720, "true"],
    ["Containers stopped", "stoppedContainers", 3, 60, "true"],
    ["Scripts keep failing", "failedScripts", 5, 120, ""],
  ]) await post("alerts/save", { name, metric, threshold: String(threshold), cooldownMinutes: String(cooldownMinutes), enabled });
  await post("users/save", { username: "maria", role: "viewer", password: PASSWORD });
  const devices = JSON.parse(readFileSync(path.join(data, "devices.json"), "utf8"));
  writeFileSync(path.join(data, "devices.json"), JSON.stringify({ ...devices, ["4d".repeat(32)]: { name: "Phone", created: new Date(Date.now() - 6 * DAY).toISOString() } }));

  // A week of scheduled runs, the way cron would have logged them.
  const schedules = (await get("state?scope=records")).schedules;
  const stamp = (at) => new Date(at).toISOString().replace(/\.\d+Z$/, "+00:00");
  const marks = [];
  const ran = (schedule, at, seconds, code) => marks.push([at, `MEDIA_DASHBOARD_START ${schedule.id} ${stamp(at)}\nMEDIA_DASHBOARD_END ${schedule.id} ${stamp(at + seconds * 1000)} ${code}`]);
  const nightly = schedules.find((item) => item.expression === "0 3 * * *"), frequent = schedules.find((item) => item.expression === "*/30 * * * *");
  for (let day = 7; day >= 1; day--) ran(nightly, new Date().setHours(3, 0, 0, 0) - (day - 1) * DAY - (new Date().getHours() < 3 ? DAY : 0), 42, 0);
  for (let half = 9; half >= 1; half--) ran(frequent, Math.floor(Date.now() / (30 * MINUTE)) * 30 * MINUTE - (half - 1) * 30 * MINUTE, 3, half === 5 ? 1 : 0);
  writeFileSync(path.join(srv, "logs", "schedules.log"), marks.sort(([a], [b]) => a - b).map(([, lines]) => lines).join("\n") + "\n");

  // A month of health samples that end at what the server reports right now.
  const { stats } = await get("state");
  const now = Date.now(), noise = random(11), busy = activity(now);
  const ram = (stats.memoryUsedBytes / stats.memoryTotalBytes) * 100, temperature = stats.temperatureC ?? 48;
  const samples = [];
  for (let at = now - 30 * DAY; at <= now - MINUTE; at += 5 * MINUTE) {
    const level = activity(at), age = (now - at) / (30 * DAY);
    samples.push({
      at,
      cpu: Math.max(0.4, stats.cpuUsagePercent + 24 * (level - busy) + 5 * (noise() - 0.5)),
      ram: Math.max(5, ram + 7 * (level - busy) + (noise() - 0.5)),
      temperature: Math.round((temperature + 13 * (level - busy) + 1.5 * (noise() - 0.5)) * 10) / 10,
      disk: Math.round(stats.diskUsedPercent - 2 * age),
      storage: { "/srv/media": Math.round(DISKS["/srv/media"][2] - 9 * age), "/srv/backups": Math.round(DISKS["/srv/backups"][2] - 3 * age) },
    });
  }
  writeFileSync(path.join(data, "metrics.json"), JSON.stringify(samples));

  // The sign-in page, from a browser that is not enrolled.
  const visitor = await browser.newContext(desktop);
  const signIn = await visitor.newPage();
  await signIn.goto("/");
  await signIn.getByText("New browser? Enter an enrollment code").click();
  await picture(signIn, "login.jpg");
  await visitor.close();

  await page.goto("/");
  await page.getByRole("heading", { name: "Overview", level: 1 }).waitFor();
  const charts = (target) => target.locator(".chart svg").first().waitFor();
  await charts(page);
  await picture(page, "overview.jpg");

  await open(page, "Containers");
  await page.locator(".container-row summary").first().click();
  await page.getByText("412MB (virtual 1.21GB)").waitFor();
  await page.locator(".metrics").evaluate((element) => window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY + 100));
  await picture(page, "containers.jpg");

  // The menu of one script is left open, to show where its actions are.
  await open(page, "Scripts");
  for (const folder of await page.locator(".script-folder summary").all()) await folder.click();
  await page.locator(".script-row", { hasText: "Clean old downloads" }).getByRole("button", { name: /^Actions for/ }).click();
  await page.getByRole("menu").waitFor();
  await picture(page, "scripts.jpg");
  await page.keyboard.press("Escape");

  await open(page, "Files");
  await page.getByLabel("Location").selectOption("/srv/media");
  await page.locator(".file-explorer-open", { hasText: "movies" }).waitFor();
  await waitFor(async () => (await page.getByText("Calculating size…").count()) === 0, "the folder sizes");
  await picture(page, "files.jpg");

  await open(page, "Schedules");
  await picture(page, "schedules.jpg");

  await open(page, "Power");
  await charts(page);
  await page.locator(".chart-filters").evaluate((element) => window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 70));
  await picture(page, "power.jpg");

  await open(page, "History");
  await page.locator(".schedule-row").first().waitFor();
  await picture(page, "history.jpg");

  await open(page, "Alerts");
  await picture(page, "alerts.jpg");

  // The channels exist only for this picture: nothing may be sent to them.
  const channels = path.join(data, "notification-channels.json");
  const events = ["alert", "script-failed", "cron-failed", "power-offline", "power-online"];
  writeFileSync(channels, JSON.stringify([
    { id: "discord", name: "Server alerts (Discord)", type: "discord", url: "https://discord.com/api/webhooks/0/demonstration", events, enabled: true },
    { id: "phone", name: "Phone (ntfy)", type: "ntfy", url: "https://ntfy.sh/demonstration", events: events.slice(0, 2), enabled: true },
  ]));
  try {
    await open(page, "Settings");
    await page.getByText("Phone (ntfy)").waitFor();
    await picture(page, "settings.jpg");
  } finally {
    rmSync(channels, { force: true });
  }

  await page.getByRole("radio", { name: "Light" }).click();
  await open(page, "Overview");
  await charts(page);
  await picture(page, "theme-light.jpg");
  await open(page, "Settings");
  await page.getByRole("radio", { name: "Dark" }).click();

  const phone = await browser.newContext({ ...desktop, viewport: { width: 389, height: 780 }, storageState: await context.storageState(), isMobile: true, hasTouch: true });
  const small = await phone.newPage();
  await small.goto("/");
  await small.getByRole("heading", { name: "Overview", level: 1 }).waitFor();
  await charts(small);
  await picture(small, "mobile.png");
  await small.getByRole("button", { name: "Open the menu" }).click();
  await picture(small, "mobile-menu.png");
  await small.keyboard.press("Escape");
  if (review) {
    for (const name of PAGES) {
      await open(small, name);
      if (name === "Scripts") for (const folder of await small.locator(".script-folder summary").all()) await folder.click();
      await picture(small, `phone-${name.toLowerCase()}.png`, { fullPage: true });
    }
    // A narrow phone, where the page's title line wraps beside its buttons.
    const narrow = await browser.newContext({ ...desktop, viewport: { width: 340, height: 700 }, storageState: await context.storageState(), isMobile: true, hasTouch: true });
    const tiny = await narrow.newPage();
    await tiny.goto("/");
    await tiny.getByRole("heading", { name: "Overview", level: 1 }).waitFor();
    await picture(tiny, "phone-narrow-overview.png");
    await narrow.close();
    // A tablet, where the pages are in the menu as well.
    const tablet = await browser.newContext({ ...desktop, viewport: { width: 768, height: 1024 }, storageState: await context.storageState(), hasTouch: true });
    const medium = await tablet.newPage();
    await medium.goto("/");
    await medium.getByRole("heading", { name: "Overview", level: 1 }).waitFor();
    await charts(medium);
    await picture(medium, "tablet-overview.png");
    await open(medium, "Containers");
    await picture(medium, "tablet-containers.png");
    await tablet.close();
    // A run in progress, in its log with the button that stops it, and the
    // form of its script, which has a time limit.
    await post("script/save", {
      name: "Rebuild search index", path: "/srv/scripts/maintenance/rebuild-index.sh", folder: "Maintenance", runAs: "user", timeLimitMinutes: "60",
      variables: "INDEX_DIR=/srv/media/.index\nTHREADS=4", singleRun: "true", notifySuccess: "true",
      runOptions: JSON.stringify([
        { label: "Rebuild everything", value: "", description: "Reads every file again" },
        { label: "One library", value: "--library {value}", description: "Only the folder named", input: "Library folder" },
      ]),
    });
    const rebuild = (await get("state?scope=records")).scripts.find((item) => item.name === "Rebuild search index");
    const { run } = await post("script/run", { id: rebuild.id, option: "0" });
    try {
      for (const [target, name] of [[small, "phone-log.png"], [page, "log.jpg"]]) {
        await open(target, "Settings");
        await open(target, "Scripts");
        const row = target.locator(".script-row", { hasText: "Rebuild search index" });
        if (!(await row.isVisible())) await target.locator(".script-folder summary", { hasText: "Maintenance" }).click();
        await row.getByRole("button", { name: "Logs" }).click();
        await target.getByText("Indexed part 3 of 40").waitFor();
        await picture(target, name);
        await target.getByRole("dialog").getByRole("button", { name: "Close" }).click();
      }
      for (const [target, name] of [[small, "phone-script-form.png"], [page, "script-form.png"]]) {
        await target.locator(".script-row", { hasText: "Rebuild search index" }).getByRole("button", { name: /^Actions for/ }).click();
        await target.getByRole("menuitem", { name: "Edit" }).click();
        const form = target.getByRole("dialog", { name: "Edit script" });
        await form.waitFor();
        await form.locator(".run-conditions").scrollIntoViewIfNeeded();
        await picture(target, name);
        await form.locator(".run-options-editor").scrollIntoViewIfNeeded();
        await picture(target, name.replace("form", "options"));
        await form.getByRole("button", { name: "Close" }).click();
      }
    } finally {
      await post("script/stop", { runId: run.id });
    }
  }

  await browser.close();
  console.log(`Wrote the pictures to ${review ?? path.relative(root, out)}.`);
}

main().then(() => stop(0), (error) => { console.error(error); stop(1); });
