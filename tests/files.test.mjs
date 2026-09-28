import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadServer, plain, realHost } from "./harness.mjs";

// A real directory tree: an allowed root, a sibling outside it, and a symlink
// inside the root that points out of it.
function tree() {
  const base = mkdtempSync(path.join(tmpdir(), "lsc-files-"));
  const root = path.join(base, "allowed"), outside = path.join(base, "allowed-not");
  mkdirSync(path.join(root, "docs"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(root, "notes.txt"), "hello\n");
  writeFileSync(path.join(root, "docs", "a.txt"), "a\n");
  writeFileSync(path.join(outside, "secret.txt"), "secret\n");
  writeFileSync(path.join(root, "image.bin"), Buffer.from([0, 1, 2, 3, 255, 0, 7]));
  symlinkSync(outside, path.join(root, "escape"));
  const { server } = loadServer({ host: realHost, env: { ALLOWED_PATHS: root, SCRIPT_ROOT: root } });
  return { server, root, outside };
}

test("browsing stays inside the allowed locations, also through symlinks", async () => {
  const { server, root, outside } = tree();
  const listing = plain(await server.browseFiles(root));
  assert.deepEqual(listing.entries.map((entry) => entry.name).sort(), ["docs", "image.bin", "notes.txt"], "symlinks are not listed");
  assert.equal(listing.parent, null, "no way up from a root");
  await assert.rejects(server.browseFiles(outside), /outside the allowed locations/);
  await assert.rejects(server.browseFiles(path.join(root, "escape")), /outside the allowed locations/);
  await assert.rejects(server.browseFiles(path.join(root, "..")), /outside the allowed locations/);
});

test("copy, move and rename work inside the root and refuse to leave it", async () => {
  const { server, root, outside } = tree();
  await server.changeFile("copy", path.join(root, "notes.txt"), path.join(root, "docs"));
  assert.equal(readFileSync(path.join(root, "docs", "notes.txt"), "utf8"), "hello\n");
  await server.changeFile("rename", path.join(root, "docs", "notes.txt"), "", "renamed.txt");
  assert.ok(existsSync(path.join(root, "docs", "renamed.txt")));
  await server.changeFile("move", path.join(root, "docs", "renamed.txt"), root);
  assert.ok(existsSync(path.join(root, "renamed.txt")));
  await assert.rejects(server.changeFile("move", path.join(root, "notes.txt"), outside), /allowed destination/);
  await assert.rejects(server.changeFile("copy", path.join(outside, "secret.txt"), root), /outside the allowed locations/);
  await assert.rejects(server.changeFile("rename", path.join(root, "notes.txt"), "", "../escaped.txt"), /valid name/);
  await assert.rejects(server.changeFile("move", path.join(root, "docs"), path.join(root, "docs")), /different allowed destination|inside itself/);
  await assert.rejects(server.changeFile("copy", path.join(root, "notes.txt"), root), /different allowed destination/);
  writeFileSync(path.join(root, "a.txt"), "other\n");
  await assert.rejects(server.changeFile("copy", path.join(root, "docs", "a.txt"), root), /already exists/);
  assert.equal(readFileSync(path.join(root, "a.txt"), "utf8"), "other\n", "an existing file is never overwritten");
  assert.ok(existsSync(path.join(root, "notes.txt")) && !existsSync(path.join(path.dirname(root), "escaped.txt")));
});

test("deleting refuses roots, symlinks and outside paths", async () => {
  const { server, root, outside } = tree();
  await assert.rejects(server.changeFile("delete", root), /cannot be deleted/);
  await assert.rejects(server.changeFile("delete", path.join(root, "escape")), /outside the allowed locations|symbolic links/);
  await assert.rejects(server.changeFile("delete", path.join(outside, "secret.txt")), /outside the allowed locations/);
  assert.ok(existsSync(path.join(outside, "secret.txt")));
  await server.changeFile("delete", path.join(root, "docs"));
  assert.ok(!existsSync(path.join(root, "docs")));
});

test("the editor reads and saves text files inside the root only", async () => {
  const { server, root, outside } = tree();
  const file = plain(await server.readEditableFile(path.join(root, "notes.txt")));
  assert.equal(file.content, "hello\n");
  await server.saveEditableFile(path.join(root, "notes.txt"), "changed\n");
  assert.equal(readFileSync(path.join(root, "notes.txt"), "utf8"), "changed\n");
  await assert.rejects(server.readEditableFile(path.join(root, "image.bin")), /not a supported text file/);
  await assert.rejects(server.readEditableFile(path.join(outside, "secret.txt")), /inside an allowed location/);
  await assert.rejects(server.saveEditableFile(path.join(root, "escape", "secret.txt"), "x"), /inside an allowed location/);
  assert.equal(readFileSync(path.join(outside, "secret.txt"), "utf8"), "secret\n");
  writeFileSync(path.join(root, "big.txt"), "x".repeat(600 * 1024));
  await assert.rejects(server.readEditableFile(path.join(root, "big.txt")), /up to 512 KB/);
});

test("new files and folders are created inside the root with valid names only", async () => {
  const { server, root } = tree();
  await server.createFileOrFolder(root, "new-folder", "folder");
  await server.createFileOrFolder(path.join(root, "new-folder"), "empty.txt", "file");
  assert.ok(existsSync(path.join(root, "new-folder", "empty.txt")));
  await assert.rejects(server.createFileOrFolder(root, "../outside.txt", "file"), /valid name/);
  await assert.rejects(server.createFileOrFolder(root, "notes.txt", "file"), /already exists/);
});
