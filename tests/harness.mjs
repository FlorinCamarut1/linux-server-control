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
    spawn() { throw new Error("spawn is not available in tests"); },
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

// Values created inside the VM have that context's prototypes; compare as JSON.
export const plain = (value) => JSON.parse(JSON.stringify(value));
