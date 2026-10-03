import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const transpiled = new Map();
function transpile(file) {
  if (!transpiled.has(file))
    transpiled.set(file, ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText);
  return transpiled.get(file);
}
// Runs a TypeScript module and the modules it imports by relative path in one
// VM context. `modules` answers every other import; anything it leaves out
// comes from Node.
function loadModule(entry, globals, modules = () => undefined) {
  const context = vm.createContext(globals);
  const loaded = new Map();
  const load = (file) => {
    if (loaded.has(file)) return loaded.get(file).exports;
    const unit = { exports: {} };
    loaded.set(file, unit);
    const requireFrom = (name) => modules(name) ?? (name.startsWith(".") ? load(path.resolve(path.dirname(file), name) + ".ts") : require(name));
    vm.runInContext(`(function (exports, require, module) {${transpile(file)}\n})`, context)(unit.exports, requireFrom, unit);
    return unit.exports;
  };
  return load(fileURLToPath(new URL(entry, import.meta.url)));
}

// Loads src/lib/server.ts in its own context with a fresh DATA_DIR. Host commands
// never run: `host(args, input)` answers them with { stdout, stderr, code } or a
// thrown error, and every command is recorded in `commands`. With
// realProcesses, commands run for real instead, for tests of running scripts.
export function loadServer({ env = {}, host = () => ({ stdout: "" }), delay = 0, realProcesses = false } = {}) {
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
    // A process whose output comes from `host` once its stdin is closed. A
    // process that never reads its stdin (a script run) keeps running.
    spawn(command, args) {
      const child = new EventEmitter();
      const argv = [command, ...args];
      const entry = { argv, input: undefined };
      commands.push(entry);
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      child.stdin = {
        on() {},
        end(input) {
          entry.input = input;
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
  const server = loadModule("../src/lib/server.ts", {
    Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
    console: { ...console, error() {} },
    process: { env: { DATA_DIR: data, SSH_TARGET: "", ALLOWED_PATHS: "/srv/scripts", SCRIPT_ROOT: "/srv/scripts", MONITORED_PATHS: "/srv/example", ...env } },
  }, (name) => (name === "node:child_process" && !realProcesses ? childProcess : undefined));
  const file = (name) => path.join(data, name + ".json");
  return {
    server, commands, data,
    readJson: (name) => JSON.parse(readFileSync(file(name), "utf8")),
    fileText: (name) => { try { return readFileSync(file(name), "utf8"); } catch { return null; } },
  };
}

// Loads src/lib/power.ts on top of a server loaded with loadServer.
export function loadPower(server) {
  return loadModule("../src/lib/power.ts", { Buffer, fetch, AbortSignal, URL, URLSearchParams, setTimeout, console },
    (name) => (name === "./server" ? server : undefined));
}

// Runs host commands for real, for tests that work on a temporary directory.
export function realHost(argv, input) {
  const result = spawnSync(argv[0], argv.slice(1), { input: input ?? "", encoding: "utf8" });
  return { stdout: result.stdout, stderr: result.stderr, code: result.status ?? 1 };
}

// Loads the API's http and auth modules on top of a server loaded with loadServer.
export function loadApi(server, env = {}) {
  const load = (entry, modules) => loadModule(entry, { Buffer, console, process: { env } }, (name) => modules[name]);
  const http = load("../src/lib/api/http.ts", { "@/lib/server": server });
  const auth = load("../src/lib/api/auth.ts", { "@/lib/server": server, "./http": http });
  return { http, auth };
}

// Loads src/lib/notify.ts on top of a server loaded with loadServer.
export function loadNotify(server) {
  const power = loadPower(server);
  return loadModule("../src/lib/notify.ts", { Buffer, fetch, AbortSignal, URL, console: { ...console, error() {} } },
    (name) => (name === "./server" ? server : name === "./power" ? power : undefined));
}

// Values created inside the VM have that context's prototypes; compare as JSON.
export const plain = (value) => JSON.parse(JSON.stringify(value));
