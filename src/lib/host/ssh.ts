// The connection settings and the one way commands reach the managed server.
import { execFile } from "node:child_process";
import { read, save } from "./store";
// The root helpers installed by scripts/install-root-*.sh.
export const ROOT_CRON_HELPER = "/usr/local/sbin/media-dashboard-root-cron";
export const ROOT_SCRIPT_HELPER = "/usr/local/sbin/media-dashboard-root-run";
export type ServerSettings = {
  sshTarget: string;
  sshPort: number;
  scriptRoot: string;
  allowedPaths: string[];
  remoteLogs: string;
  metricsRetentionDays: number;
};
const defaultServerSettings = (): ServerSettings => {
  const scriptRoot = process.env.SCRIPT_ROOT || "/home";
  return {
    sshTarget: process.env.SSH_TARGET || "",
    sshPort: validPort(Number(process.env.SSH_PORT)) ? Number(process.env.SSH_PORT) : 22,
    scriptRoot,
    allowedPaths: [...new Set((process.env.ALLOWED_PATHS || scriptRoot).split(",").map((item) => item.trim().replace(/\/$/, "")).filter((item) => item.startsWith("/")))],
    remoteLogs: process.env.REMOTE_LOGS || "/tmp/media-dashboard",
    metricsRetentionDays: Math.max(1, Math.min(365, Number(process.env.METRICS_RETENTION_DAYS || 30) || 30)),
  };
};
const validPort = (value: number) => Number.isInteger(value) && value >= 1 && value <= 65535;
function cleanPath(value: string) {
  const cleaned = value.trim().replace(/\/$/, "");
  if (!cleaned.startsWith("/") || /[\r\n\0]/.test(cleaned)) throw Error("Use absolute paths only");
  return cleaned;
}
export function serverSettings(): ServerSettings {
  const saved = read<Partial<ServerSettings>>("server-settings", {});
  const defaults = defaultServerSettings();
  return {
    sshTarget: typeof saved.sshTarget === "string" ? saved.sshTarget : defaults.sshTarget,
    sshPort: typeof saved.sshPort === "number" && validPort(saved.sshPort) ? saved.sshPort : defaults.sshPort,
    scriptRoot: typeof saved.scriptRoot === "string" ? saved.scriptRoot : defaults.scriptRoot,
    allowedPaths: Array.isArray(saved.allowedPaths) && saved.allowedPaths.length ? saved.allowedPaths : defaults.allowedPaths,
    remoteLogs: typeof saved.remoteLogs === "string" ? saved.remoteLogs : defaults.remoteLogs,
    metricsRetentionDays: typeof saved.metricsRetentionDays === "number" ? saved.metricsRetentionDays : defaults.metricsRetentionDays,
  };
}
export function updateServerSettings(input: Partial<ServerSettings>) {
  const settings = validateServerSettings(input);
  save("server-settings", settings);
  return settings;
}
export function validateServerSettings(input: Partial<ServerSettings>): ServerSettings {
  const current = serverSettings();
  const sshTarget = (input.sshTarget ?? current.sshTarget).trim();
  if (sshTarget && !/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.:-]+$/.test(sshTarget))
    throw Error("SSH target must look like user@host");
  const sshPort = Number(input.sshPort ?? current.sshPort);
  if (!validPort(sshPort)) throw Error("SSH port must be between 1 and 65535");
  const scriptRoot = cleanPath(input.scriptRoot ?? current.scriptRoot);
  const allowedPaths = (input.allowedPaths ?? current.allowedPaths).map(cleanPath);
  if (!allowedPaths.length) throw Error("Keep at least one allowed path");
  const retention = Number(input.metricsRetentionDays ?? current.metricsRetentionDays);
  if (!Number.isInteger(retention) || retention < 1 || retention > 365) throw Error("Metric retention must be between 1 and 365 days");
  return { sshTarget, sshPort, scriptRoot, allowedPaths: [...new Set(allowedPaths)], remoteLogs: cleanPath(input.remoteLogs ?? current.remoteLogs), metricsRetentionDays: retention };
}
export function allowedRoots() { return serverSettings().allowedPaths; }
// Reuses one SSH connection for the many short commands a page load issues,
// instead of a full handshake for each. The socket lives in the /tmp tmpfs.
function multiplexOptions() {
  if (process.env.SSH_MULTIPLEX === "false") return [];
  return ["-o", "ControlMaster=auto", "-o", "ControlPath=/tmp/lsc-ssh-%C", "-o", "ControlPersist=60"];
}
// The private key and the server's recorded identity, mounted into the
// container; SSH_KEY_FILE and SSH_KNOWN_HOSTS_FILE name other files.
const sshKeyFile = () => process.env.SSH_KEY_FILE || "/run/ssh/id_ed25519";
const sshKnownHostsFile = () => process.env.SSH_KNOWN_HOSTS_FILE || "/run/ssh/known_hosts";
export const ssh = (args: string[]): [string, string[]] => {
  const { sshTarget: target, sshPort } = serverSettings();
  return target
    ? [
        "ssh",
        [
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=8",
          "-o",
          "StrictHostKeyChecking=yes",
          "-i",
          sshKeyFile(),
          "-p",
          String(sshPort),
          "-o",
          `UserKnownHostsFile=${sshKnownHostsFile()}`,
          ...multiplexOptions(),
          target,
          shell(args),
        ],
      ]
    : [args[0], args.slice(1)];
};
export async function testServerConnection() {
  const target = serverSettings().sshTarget;
  if (!target) return { host: "local", mode: "local" as const };
  const host = (await runAsync(["hostname"], 12000)).trim();
  return { host, mode: "ssh" as const, target };
}
// Quotes arguments for the command line that the SSH user's login shell reads,
// which is not always a POSIX shell: between single quotes fish also reads \\
// and \' as escapes, so a script containing a backslash arrived changed. A
// backslash is therefore written outside the quotes, like a quote; there bash,
// dash, zsh and fish all read \\ and \' the same way.
export function shell(args: string[]) {
  return args.map((x) => "'" + x.replace(/[\\']/g, (special) => `'\\${special}'`) + "'").join(" ");
}
// Raised when a host command fails. Its message is safe to show in the browser:
// it never contains the SSH command line, key path, or script arguments.
export class CommandError extends Error {}
// The last failure logged per command, so a command that fails on every refresh
// (Docker on a server without it) is logged once, not every 15 seconds.
const loggedFailures = new Map<string, string>();
export function runAsync(args: string[], timeout = 30000, input?: string) {
  const [command, arguments_] = ssh(args);
  return new Promise<string>((resolve, reject) => {
    const child = execFile(command, arguments_, { encoding: "utf8", timeout, maxBuffer: 4e6 }, (error, stdout, stderr) => {
      if (!error) {
        loggedFailures.delete(args[0]);
        return resolve(stdout);
      }
      const detail = String(stderr || "").trim().split("\n").filter(Boolean).pop();
      const logged = detail || (error.killed ? "timed out" : `exit ${error.code}`);
      if (loggedFailures.get(args[0]) !== logged) {
        loggedFailures.set(args[0], logged);
        console.error(`Host command failed (${args[0]}): ${logged}`);
      }
      // Node also ends a command whose output passes maxBuffer, which is not a timeout.
      const tooLong = (error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      reject(new CommandError(tooLong ? "The server command returned too much output" : error.killed ? "The server command timed out" : detail || "The server command failed"));
    });
    child?.stdin?.on("error", () => {});
    child?.stdin?.end(input ?? "");
  });
}
export const run = runAsync;
export function runInput(args: string[], input: string, timeout = 30000) {
  return runAsync(args, timeout, input);
}
