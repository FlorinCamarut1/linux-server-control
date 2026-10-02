// Starts the production build for the browser tests: a copy of the standalone
// server with fresh data, managing this machine directly instead of over SSH.
import { spawn } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const standalone = path.join(root, ".next", "standalone");
if (!existsSync(path.join(standalone, "server.js"))) {
  console.error("No production build found. Run `npm run build` first.");
  process.exit(1);
}
const tmp = path.join(root, "e2e", ".tmp");
const app = path.join(tmp, "app"), data = path.join(tmp, "data"), files = path.join(tmp, "files"), logs = path.join(tmp, "logs");
rmSync(tmp, { recursive: true, force: true });
// A local build also traces the developer's own .env and data folder; the
// tests must never read them.
cpSync(standalone, app, { recursive: true, filter: (source) => ![".env", "data"].includes(path.relative(standalone, source)) });
cpSync(path.join(root, ".next", "static"), path.join(app, ".next", "static"), { recursive: true });
const bin = path.join(tmp, "bin");
for (const folder of [data, files, logs, bin]) mkdirSync(folder, { recursive: true });
writeFileSync(path.join(files, "notes.txt"), "A file for the browser tests.\n");

// A `crontab` that keeps its table in a file, so schedules can be tested
// without touching this machine's crontab. It starts with an entry of the
// user's own, which the dashboard must leave alone.
const crontab = path.join(tmp, "crontab");
writeFileSync(crontab, "# my own job\n0 1 * * * true\n");
writeFileSync(path.join(bin, "crontab"), `#!/bin/sh
case "$1" in
  -l) cat '${crontab}' ;;
  -) cat > '${crontab}' ;;
  *) exit 64 ;;
esac
`, { mode: 0o755 });

// A Shelly Gen2 plug: it reports 9 W while on and can be switched.
const plug = { on: true };
createServer((req, res) => {
  const url = new URL(req.url, "http://plug");
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/rpc/Switch.GetStatus") return res.end(JSON.stringify({ apower: plug.on ? 9 : 0, output: plug.on }));
  if (url.pathname === "/rpc/Switch.Set") { plug.on = url.searchParams.get("on") === "true"; return res.end("{}"); }
  res.statusCode = 404; res.end("{}");
}).listen(3211, "127.0.0.1");

// A webhook receiver that records every notification it is sent.
const webhooks = path.join(tmp, "webhooks.jsonl");
writeFileSync(webhooks, "");
createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  appendFileSync(webhooks, Buffer.concat(chunks).toString().replaceAll("\n", " ") + "\n");
  res.statusCode = 204; res.end();
}).listen(3212, "127.0.0.1");

const server = spawn(process.execPath, ["server.js"], {
  cwd: app,
  stdio: "inherit",
  env: {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    NODE_ENV: "production", PORT: "3210", HOSTNAME: "127.0.0.1",
    DATA_DIR: data, SSH_TARGET: "", SCRIPT_ROOT: files, ALLOWED_PATHS: files,
    MONITORED_PATHS: "/", REMOTE_LOGS: logs, SSH_MULTIPLEX: "false",
  },
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
server.on("exit", (code) => process.exit(code ?? 0));
