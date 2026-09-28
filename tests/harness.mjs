import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = ts.transpileModule(
  readFileSync(new URL("../src/lib/server.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } },
).outputText;

// Loads src/lib/server.ts in its own context with a fresh DATA_DIR. Host commands
// never run: `host(args, input)` answers them with { stdout, stderr, code } or a
// thrown error, and every command is recorded in `commands`.
export function loadServer({ env = {}, host = () => ({ stdout: "" }), delay = 0 } = {}) {
  const data = mkdtempSync(path.join(tmpdir(), "lsc-test-"));
  const commands = [];
  const childProcess = {
    execFile(command, args, options, callback) {
      // Without an SSH target the first argument is the command itself.
      const argv = [command, ...args];
      let settled = false;
      const answer = (input) => {
        if (settled) return;
        settled = true;
        commands.push({ argv, input });
        setTimeout(() => {
          let result;
          try { result = host(argv, input) ?? {}; }
          catch (error) { return callback(error, "", ""); }
          if (result.code) {
            const error = Object.assign(new Error(`Command failed: ${argv.join(" ")}`), { code: result.code });
            return callback(error, result.stdout || "", result.stderr || "");
          }
          callback(null, result.stdout || "", result.stderr || "");
        }, delay);
      };
      return { stdin: { on() {}, end: answer } };
    },
    // A process whose output comes from `host` once its stdin is closed.
    spawn(command, args) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      child.stdin = {
        on() {},
        end(input) {
          const argv = [command, ...args];
          commands.push({ argv, input });
          setTimeout(() => {
            let result;
            try { result = host(argv, input) ?? {}; }
            catch (error) { return child.emit("error", error); }
            if (result.stdout) child.stdout.emit("data", result.stdout);
            if (result.stderr) child.stderr.emit("data", result.stderr);
            child.emit("close", result.code ?? 0);
          }, delay);
        },
      };
      return child;
    },
  };
  const context = {
    exports: {}, Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
    console: { ...console, error() {} },
    process: { env: { DATA_DIR: data, SSH_TARGET: "", ALLOWED_PATHS: "/srv/scripts", SCRIPT_ROOT: "/srv/scripts", MONITORED_PATHS: "/srv/example", ...env } },
    require(name) { return name === "node:child_process" ? childProcess : require(name); },
  };
  vm.runInNewContext(source, context);
  const file = (name) => path.join(data, name + ".json");
  return {
    server: context.exports, commands, data,
    readJson: (name) => JSON.parse(readFileSync(file(name), "utf8")),
    fileText: (name) => { try { return readFileSync(file(name), "utf8"); } catch { return null; } },
  };
}

// Loads src/lib/power.ts on top of a server loaded with loadServer.
export function loadPower(server) {
  const source = ts.transpileModule(readFileSync(new URL("../src/lib/power.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const context = {
    exports: {}, Buffer, fetch, AbortSignal, URLSearchParams, setTimeout, console,
    require(name) { return name === "./server" ? server : require(name); },
  };
  vm.runInNewContext(source, context);
  return context.exports;
}

// Runs host commands for real, for tests that work on a temporary directory.
export function realHost(argv, input) {
  const result = spawnSync(argv[0], argv.slice(1), { input: input ?? "", encoding: "utf8" });
  return { stdout: result.stdout, stderr: result.stderr, code: result.status ?? 1 };
}

const transpile = (path) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
// Loads the API's http and auth modules on top of a server loaded with loadServer.
export function loadApi(server, env = {}) {
  const load = (path, modules) => {
    const context = { exports: {}, Buffer, console, process: { env }, require: (name) => modules[name] ?? require(name) };
    vm.runInNewContext(transpile(path), context);
    return context.exports;
  };
  const http = load("../src/lib/api/http.ts", { "@/lib/server": server });
  const auth = load("../src/lib/api/auth.ts", { "@/lib/server": server, "./http": http });
  return { http, auth };
}

// Loads src/lib/notify.ts on top of a server loaded with loadServer.
export function loadNotify(server) {
  const context = { exports: {}, Buffer, fetch, AbortSignal, URL, console: { ...console, error() {} }, require: (name) => (name === "./server" ? server : require(name)) };
  vm.runInNewContext(transpile("../src/lib/notify.ts"), context);
  return context.exports;
}

// Values created inside the VM have that context's prototypes; compare as JSON.
export const plain = (value) => JSON.parse(JSON.stringify(value));
