import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { promisify } from "node:util";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/lib/server.ts", import.meta.url), "utf8");

function harness() {
  const calls = [];
  let failDocker = false;
  const childProcess = {
    execFileSync() { throw new Error("Snapshot must not block the event loop"); },
    execFile(command, args, options, callback) {
      calls.push(command);
      setTimeout(() => {
        if (command === "docker" && failDocker) return callback(new Error("offline"));
        const output = command === "docker" ? '{"Names":"example"}\n'
          : command === "df" ? 'Filesystem 1-blocks Used Available Capacity Mounted\n/dev/example 1000 200 800 20% /srv/example\n'
          : command === "bash" ? 'cpuUsagePercent=12.5\nmemoryTotalBytes=1000\n'
          : "";
        callback(null, output, "");
      }, 5);
    },
  };
  // Match Node's custom execFile promisifier, which returns both streams.
  childProcess.execFile[promisify.custom] = (...args) => new Promise((resolve, reject) => {
    childProcess.execFile(...args, (error, stdout, stderr) =>
      error ? reject(error) : resolve({ stdout, stderr }));
  });
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, Buffer, setTimeout, clearTimeout,
    process: { env: { DATA_DIR: "/unused", MONITORED_PATHS: "/srv/example" } },
    require(name) {
      if (name === "node:child_process") return childProcess;
      if (name === "node:fs") return { ...require(name), mkdirSync() {} };
      return require(name);
    },
  });
  return { exports, calls, fail() { failDocker = true; } };
}

test("simultaneous snapshots share asynchronous host reads; next refresh reads again", async () => {
  const { exports, calls } = harness();
  const first = exports.hostSnapshot();
  const second = exports.hostSnapshot();
  assert.equal(first, second);
  assert.ok(calls.includes("docker") && calls.includes("bash") && calls.includes("date"));
  const snapshot = await first;
  assert.equal(snapshot.stats.cpuUsagePercent, 12.5);
  assert.equal(snapshot.stats.storage[0].usedPercent, 20);
  assert.equal(calls.filter((name) => name === "docker").length, 1);
  await exports.hostSnapshot();
  assert.equal(calls.filter((name) => name === "docker").length, 2);
});

test("failed reads do not poison later snapshots", async () => {
  const { exports, calls, fail } = harness();
  fail();
  await assert.rejects(exports.hostSnapshot(), /offline/);
  await assert.rejects(exports.hostSnapshot(), /offline/);
  assert.equal(calls.filter((name) => name === "docker").length, 2);
});
