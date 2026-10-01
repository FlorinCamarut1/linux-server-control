// Starts the production build for the browser tests: a copy of the standalone
// server with fresh data, managing this machine directly instead of over SSH.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
for (const folder of [data, files, logs]) mkdirSync(folder, { recursive: true });
writeFileSync(path.join(files, "notes.txt"), "A file for the browser tests.\n");

const server = spawn(process.execPath, ["server.js"], {
  cwd: app,
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "production", PORT: "3210", HOSTNAME: "127.0.0.1",
    DATA_DIR: data, SSH_TARGET: "", SCRIPT_ROOT: files, ALLOWED_PATHS: files,
    MONITORED_PATHS: "/", REMOTE_LOGS: logs, SSH_MULTIPLEX: "false",
  },
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
server.on("exit", (code) => process.exit(code ?? 0));
