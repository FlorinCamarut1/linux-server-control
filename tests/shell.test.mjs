import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadServer, plain } from "./harness.mjs";

// What a shell could change in an argument: quotes, backslashes, and whatever
// looks like an expansion, a comment or a separator.
const AWKWARD = ["plain", "", "it's", "a\\b", "a\\\\b", "ends with \\", "\\'", "'\\", "''", "$HOME `id` $(id) *", "two\nlines", "tab\there", 'say "hi"', "~/x", "#not a comment", "{a,b}", "a;b|c&d>e<f", "%s", "ș and 日本"];

// Reads a command line the way a shell does, limited to what shell() writes:
// text between single quotes, and \\ or \' outside them. Fish, unlike the
// POSIX shells, also reads those two escapes between single quotes.
function parse(line, { escapesInQuotes }) {
  const args = [];
  let current = "", started = false, quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index], next = line[index + 1];
    if (quoted) {
      if (char === "'") quoted = false;
      else if (escapesInQuotes && char === "\\" && (next === "\\" || next === "'")) { current += next; index++; }
      else current += char;
    } else if (char === "'") { quoted = true; started = true; }
    else if (char === "\\") { current += next; index++; started = true; }
    else if (char === " ") { if (started) args.push(current); current = ""; started = false; }
    else throw Error(`shell() wrote ${JSON.stringify(char)} outside quotes`);
  }
  assert.ok(!quoted, "the quotes are balanced");
  if (started) args.push(current);
  return args;
}

test("quoted arguments read the same in POSIX shells and in fish", () => {
  const { server } = loadServer();
  const line = server.shell(AWKWARD);
  assert.deepEqual(parse(line, { escapesInQuotes: false }), AWKWARD, "sh, bash, dash, zsh");
  assert.deepEqual(parse(line, { escapesInQuotes: true }), AWKWARD, "fish");
  assert.equal(server.shell(["docker", "ps"]), "'docker' 'ps'", "ordinary arguments stay as they were");
});

// The shells installed on this machine, as login shells of the SSH user.
const SHELLS = ["sh", "bash", "dash", "zsh", "fish"].filter((name) => spawnSync(name, ["-c", "exit 0"]).status === 0);
const PRINT_ARGUMENTS = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";

for (const loginShell of SHELLS) {
  test(`${loginShell} as the login shell receives every argument unchanged`, () => {
    const { server } = loadServer();
    const result = spawnSync(loginShell, ["-c", server.shell([process.execPath, "-e", PRINT_ARGUMENTS, "--", ...AWKWARD])], { encoding: "utf8" });
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), AWKWARD);
  });

  // Over SSH the whole command line is read by the login shell first. The file
  // script contains backslashes, which fish used to change.
  test(`${loginShell} as the login shell runs the file and statistics scripts`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lsc-shell-"));
    writeFileSync(path.join(root, "it's a file.txt"), "hello\n");
    const host = (argv, input) => {
      assert.equal(argv[0], "ssh");
      const result = spawnSync(loginShell, ["-c", argv.at(-1)], { input: input ?? "", encoding: "utf8" });
      return { stdout: result.stdout, stderr: result.stderr, code: result.status ?? 1 };
    };
    const { server } = loadServer({ host, env: { SSH_TARGET: "admin@server", ALLOWED_PATHS: root, SCRIPT_ROOT: root, MONITORED_PATHS: root, REMOTE_LOGS: path.join(root, "logs") } });
    const listing = plain(await server.browseFiles(root));
    assert.deepEqual(listing.entries.map((entry) => entry.name), ["it's a file.txt"]);
    assert.equal(plain(await server.readEditableFile(path.join(root, "it's a file.txt"))).content, "hello\n");
    // The script's own check for a backslash in a name is the line fish broke.
    await assert.rejects(server.changeFile("rename", path.join(root, "it's a file.txt"), "", "back\\slash.txt"), /valid name/);
    await server.changeFile("rename", path.join(root, "it's a file.txt"), "", "renamed 'again'.txt");
    assert.deepEqual(plain(await server.browseFiles(root)).entries.map((entry) => entry.name), ["renamed 'again'.txt"]);
    // The snapshot creates the logs folder, which is listed from then on.
    const snapshot = await server.hostSnapshot();
    assert.ok(snapshot.stats.memoryTotalBytes > 0 && snapshot.stats.cpuCores > 0, "the statistics script ran");
    assert.equal(snapshot.stats.storage[0].path, root);
    assert.ok(snapshot.stats.storage[0].totalBytes > 0, "the monitored path was measured");
  });
}
