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
  const { server, commands } = loadServer({ host: realHost, env: { ALLOWED_PATHS: root, SCRIPT_ROOT: root } });
  return { server, root, outside, commands };
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
  writeFileSync(path.join(root, "empty.txt"), "");
  assert.equal(plain(await server.readEditableFile(path.join(root, "empty.txt"))).content, "", "a new, empty file opens");
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

test("a folder is listed once for all its pages, and again after a change", async () => {
  const { server, root, commands } = tree();
  for (let index = 0; index < 7; index++) writeFileSync(path.join(root, `page-${index}.txt`), "x");
  const listed = () => commands.filter((item) => item.argv[0] === "python3").length;
  const first = plain(await server.browseFiles(root, { limit: 3 }));
  assert.deepEqual([first.entries.length, first.offset, first.limit], [3, 0, 3]);
  const second = plain(await server.browseFiles(root, { offset: 3, limit: 3 }));
  const third = plain(await server.browseFiles(root, { offset: 6, limit: 3 }));
  assert.equal(listed(), 1, "later pages come from the first page's listing");
  assert.equal(second.total, first.total);
  const names = [...first.entries, ...second.entries, ...third.entries].map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length, "no entry appears on two pages");
  assert.deepEqual([second.parent, plain(second.roots)], [first.parent, plain(first.roots)]);

  await server.browseFiles(root, { limit: 3 });
  assert.equal(listed(), 2, "opening the first page lists again");
  await server.createFileOrFolder(root, "added.txt", "file");
  const after = plain(await server.browseFiles(root, { offset: 3, limit: 3 }));
  assert.equal(after.total, first.total + 1, "a change through the dashboard forgets the listing");
  // Another search is another listing.
  const before = listed();
  const found = plain(await server.browseFiles(root, { search: "page-", offset: 3, limit: 3 }));
  assert.equal(found.total, 7);
  assert.equal(listed(), before + 1);
});

test("sorting by size measures folders first and pages through the whole folder", async () => {
  const { server, root } = tree();
  writeFileSync(path.join(root, "docs", "large.txt"), "x".repeat(50000));
  writeFileSync(path.join(root, "medium.txt"), "x".repeat(20000));
  const bySize = plain(await server.browseFiles(root, { sort: "size" }));
  assert.deepEqual(bySize.entries.slice(0, 2).map((entry) => entry.name), ["docs", "medium.txt"], "largest first, folders by their contents");
  assert.ok(bySize.entries[0].size >= 50000);
  const second = plain(await server.browseFiles(root, { sort: "size", offset: 1, limit: 1 }));
  assert.deepEqual(second.entries.map((entry) => entry.name), ["medium.txt"]);
  assert.equal(second.total, bySize.total, "every page reports the full count");
  const byName = plain(await server.browseFiles(root));
  assert.equal(byName.entries[0].size, null, "name listings leave folder sizes for later");
});
