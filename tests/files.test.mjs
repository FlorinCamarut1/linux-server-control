import assert from "node:assert/strict";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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

// What the server prints while it measures the folders in `folder`.
const printed = (folder, sizes, complete = true) =>
  [{ path: folder }, ...Object.entries(sizes).map(([each, size]) => ({ folder: each, size })), { complete }].map((line) => JSON.stringify(line) + "\n").join("");
const action = (command) => { try { return JSON.parse(command.input).action; } catch { return undefined; } };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listingOf = (folder, names) => JSON.stringify({ path: folder, roots: ["/srv/media"], parent: null, entries: names.map((name) => ({ name, path: `${folder}/${name}`, type: "directory", size: null, modified: 1 })), total: names.length });

test("sorting by size measures folders first and pages through the whole folder", async () => {
  const { server, root, commands } = tree();
  writeFileSync(path.join(root, "docs", "large.txt"), "x".repeat(50000));
  writeFileSync(path.join(root, "medium.txt"), "x".repeat(20000));
  const bySize = plain(await server.browseFiles(root, { sort: "size" }));
  assert.deepEqual(bySize.entries.slice(0, 2).map((entry) => entry.name), ["docs", "medium.txt"], "largest first, folders by their contents");
  assert.equal(bySize.entries[0].size, 50002);
  const second = plain(await server.browseFiles(root, { sort: "size", offset: 1, limit: 1 }));
  assert.deepEqual(second.entries.map((entry) => entry.name), ["medium.txt"]);
  assert.equal(second.total, bySize.total, "every page reports the full count");
  const measured = commands.filter((item) => action(item) === "sizes").length;
  const byName = plain(await server.browseFiles(root));
  assert.equal(byName.entries.find((entry) => entry.name === "docs").size, 50002, "other orders show the sizes measured so far");
  assert.equal(commands.filter((item) => action(item) === "sizes").length, measured, "without measuring again");
});

test("a folder's size counts every hard link, a symbolic link as itself, and the folders below are measured on the way", async () => {
  const { server, root, outside } = tree();
  writeFileSync(path.join(root, "docs", "big.bin"), Buffer.alloc(10000));
  mkdirSync(path.join(root, "docs", "deep"));
  writeFileSync(path.join(root, "docs", "deep", "c.txt"), "ccc");
  mkdirSync(path.join(root, "other"));
  linkSync(path.join(root, "docs", "big.bin"), path.join(root, "other", "same.bin"));
  symlinkSync(outside, path.join(root, "other", "away"));
  const { sizes } = plain(await server.folderSizes(root));
  assert.equal(sizes[path.join(root, "docs")], 2 + 10000 + 3);
  assert.equal(sizes[path.join(root, "other")], 10000 + lstatSync(path.join(root, "other", "away")).size, "measured as if alone, whatever else is measured");
  const docs = plain(await server.browseFiles(path.join(root, "docs")));
  assert.equal(docs.entries.find((entry) => entry.name === "deep").size, 3, "a folder below already has its size");
});

test("a folder is measured once for requests close together, and again when asked or after a change in it", async () => {
  const measured = [];
  const host = (argv, input) => {
    const request = JSON.parse(input || "{}");
    if (request.action !== "sizes") return { stdout: JSON.stringify({ ok: true }) };
    measured.push(request);
    return { stdout: printed("/srv/media", { "/srv/media/films": 42 }) };
  };
  const { server } = loadServer({ host, delay: 5, env: { ALLOWED_PATHS: "/srv/media" } });
  const [first, second] = await Promise.all([server.folderSizes("/srv/media"), server.folderSizes("/srv/media")]);
  assert.deepEqual(plain(first), { path: "/srv/media", sizes: { "/srv/media/films": 42 }, complete: true });
  assert.deepEqual(plain(second), plain(first));
  await server.folderSizes("/srv/media");
  assert.equal(measured.length, 1, "requests while measuring, and soon after, share one measurement");
  await server.folderSizes("/srv/media", false, true);
  assert.equal(measured.length, 2, "a fresh request measures again");
  await server.changeFile("delete", "/srv/media/films/old.mkv");
  await server.folderSizes("/srv/media");
  assert.equal(measured.length, 3, "a change in the folder measures it again");
  await server.folderSizes("/srv/media", true);
  assert.equal(measured.length, 4, "hidden files are measured apart");
});

test("a failed measurement is not kept", async () => {
  let fail = true;
  const host = () => fail ? { code: 1, stderr: "ValueError: File operation failed" } : { stdout: printed("/srv/media", {}) };
  const { server } = loadServer({ host, env: { ALLOWED_PATHS: "/srv/media" } });
  await assert.rejects(server.folderSizes("/srv/media"), /File operation failed/);
  fail = false;
  assert.deepEqual(plain(await server.folderSizes("/srv/media")).sizes, {});
});

test("sorting by size uses the folder's measurement instead of measuring again", async () => {
  const requests = [];
  let fail = false;
  const host = (argv, input) => {
    const request = JSON.parse(input || "{}");
    requests.push(request);
    if (request.action === "sizes") return fail ? { code: 1, stderr: "ValueError: File operation failed" } : { stdout: printed("/srv/media", { "/srv/media/films": 42 }) };
    return { stdout: listingOf("/srv/media", []) };
  };
  const { server } = loadServer({ host, env: { ALLOWED_PATHS: "/srv/media" } });
  await server.folderSizes("/srv/media");
  await server.browseFiles("/srv/media", { sort: "size" });
  assert.equal(requests.filter((item) => item.action === "sizes").length, 1, "the folder is measured once");
  assert.deepEqual(plain(requests.at(-1).sizes), { "/srv/media/films": 42 }, "the listing gets the measured sizes");
  assert.equal(requests.at(-1).measure, 8, "and measures only the folders made since");
  await server.browseFiles("/srv/media", { sort: "name" });
  assert.equal(requests.at(-1).sizes, undefined, "other orders do not wait for sizes");
  fail = true;
  await server.browseFiles("/srv/media", { sort: "size", fresh: true });
  assert.equal(requests.at(-1).measure, 20, "without a measurement the listing measures every folder");
});

test("a measurement cut short keeps the sizes it printed, and the next one measures the rest", async () => {
  const requests = [];
  const host = (argv, input) => {
    requests.push(JSON.parse(input || "{}"));
    return { stdout: requests.length === 1 ? printed("/srv/media", { "/srv/media/films": 42 }, false) : printed("/srv/media", { "/srv/media/shows": 7 }) };
  };
  const { server } = loadServer({ host, env: { ALLOWED_PATHS: "/srv/media" } });
  assert.equal(plain(await server.folderSizes("/srv/media")).complete, false);
  const second = plain(await server.folderSizes("/srv/media"));
  assert.deepEqual(plain(requests[1].skip), ["/srv/media/films"], "what was measured is not measured again");
  assert.deepEqual(second, { path: "/srv/media", sizes: { "/srv/media/films": 42, "/srv/media/shows": 7 }, complete: true });
});

test("a folder is measured once whether asked for as requested or as it resolved, and a folder made since on its own", async () => {
  const requests = [];
  const host = (argv, input) => {
    const request = JSON.parse(input || "{}");
    requests.push(request);
    return { stdout: request.only ? printed("/srv/media", { "/srv/media/new-download": 5 }) : printed("/srv/media", { "/srv/media/films": 42 }) };
  };
  const { server } = loadServer({ host, env: { ALLOWED_PATHS: "/srv/media" } });
  await server.folderSizes("");
  await server.folderSizes("/srv/media");
  assert.equal(requests.length, 1);
  const shown = plain(await server.folderSizes("/srv/media", false, false, ["/srv/media/films", "/srv/media/new-download"]));
  assert.equal(requests.length, 2);
  assert.deepEqual(plain(requests[1].only), ["/srv/media/new-download"], "only the folder the measurement lacks is measured");
  assert.deepEqual(shown, { path: "/srv/media", sizes: { "/srv/media/films": 42, "/srv/media/new-download": 5 }, complete: true });
});

test("Refresh shares a measurement still running, and measures again once it ended", async () => {
  let measured = 0;
  const host = (argv, input) => {
    if (JSON.parse(input || "{}").action === "sizes") measured++;
    return { stdout: printed("/srv/media", {}) };
  };
  const { server } = loadServer({ host, delay: 20, env: { ALLOWED_PATHS: "/srv/media" } });
  await Promise.all([server.folderSizes("/srv/media", false, true), server.folderSizes("/srv/media", false, true), server.folderSizes("/srv/media", false, true)]);
  assert.equal(measured, 1);
  await server.folderSizes("/srv/media", false, true);
  assert.equal(measured, 2);
});

test("the sizes of the folders shown arrive as they are measured", async () => {
  const host = () => ({ stdout: [printed("/srv/media", { "/srv/media/films": 42 }).split("\n").slice(0, 2).join("\n") + "\n", JSON.stringify({ folder: "/srv/media/shows", size: 7 }) + "\n" + JSON.stringify({ complete: true }) + "\n"] });
  const { server } = loadServer({ host, delay: 400, env: { ALLOWED_PATHS: "/srv/media" } });
  server.startFolderSizes("/srv/media");
  const first = plain(await server.folderSizes("/srv/media", false, false, ["/srv/media/films", "/srv/media/shows"]));
  assert.deepEqual(first, { path: "/srv/media", sizes: { "/srv/media/films": 42 }, complete: false }, "the first, without waiting for the rest");
  const second = plain(await server.folderSizes("/srv/media", false, false, ["/srv/media/shows"]));
  assert.deepEqual(second, { path: "/srv/media", sizes: { "/srv/media/shows": 7 }, complete: true });
});

test("a size measured a while ago is shown as stale while it is measured again, and forgotten after a day", async () => {
  let clock = Date.now(), size = 42;
  const host = (argv, input) => {
    const request = JSON.parse(input || "{}");
    return { stdout: request.action === "sizes" ? printed("/srv/media", { "/srv/media/films": size }) : listingOf("/srv/media", ["films"]) };
  };
  const { server } = loadServer({ host, now: () => clock, env: { ALLOWED_PATHS: "/srv/media" } });
  await server.folderSizes("/srv/media");
  const films = () => server.browseFiles("/srv/media").then((listing) => plain(listing.entries[0]));
  assert.deepEqual(await films(), { name: "films", path: "/srv/media/films", type: "directory", size: 42, modified: 1 });
  clock += 6 * 60 * 1000;
  size = 50;
  assert.deepEqual(await films(), { name: "films", path: "/srv/media/films", type: "directory", size: 42, modified: 1, stale: true });
  assert.deepEqual(plain(await server.folderSizes("/srv/media", false, false, ["/srv/media/films"])).sizes, { "/srv/media/films": 50 });
  assert.equal((await films()).stale, undefined);
  clock += 25 * 60 * 60 * 1000;
  assert.equal((await films()).size, null);
});

test("a change makes the folders it is in stale, forgets those below it, and stops measuring them", async () => {
  const host = (argv, input) => {
    const request = JSON.parse(input || "{}");
    if (request.action === "browse") return { stdout: request.path === "/srv/media" ? listingOf("/srv/media", ["films", "shows"]) : listingOf("/srv/media/films", ["old"]) };
    if (request.action !== "sizes") return { stdout: JSON.stringify({ ok: true }) };
    if (request.path === "/srv/media") return { stdout: printed("/srv/media", { "/srv/media/films": 42, "/srv/media/films/old": 40, "/srv/media/shows": 7 }) };
    return { stdout: [JSON.stringify({ path: request.path }) + "\n", printed(request.path, {})] };
  };
  const { server, commands } = loadServer({ host, delay: 30, env: { ALLOWED_PATHS: "/srv/media" } });
  await server.folderSizes("/srv/media");
  server.startFolderSizes("/srv/media/films");
  await server.changeFile("delete", "/srv/media/films/old");
  assert.ok(commands.find((item) => action(item) === "sizes" && JSON.parse(item.input).path === "/srv/media/films").killed, "the folder changed is no longer measured");
  const shown = plain((await server.browseFiles("/srv/media")).entries).map((entry) => [entry.name, entry.size, !!entry.stale]);
  assert.deepEqual(shown, [["films", 42, true], ["shows", 7, false]], "the folder it was in is stale, others stay as they are");
  assert.equal(plain((await server.browseFiles("/srv/media/films")).entries)[0].size, null, "what was deleted is forgotten");
});

test("a measurement nobody waits for is stopped, and keeps the sizes it printed", async () => {
  const host = () => ({ stdout: [printed("/srv/media", { "/srv/media/films": 42 }).split("\n").slice(0, 2).join("\n") + "\n", ...Array(20).fill("")] });
  const { server, commands } = loadServer({ host, delay: 300, env: { ALLOWED_PATHS: "/srv/media" } });
  server.startFolderSizes("/srv/media");
  await pause(4000);
  assert.ok(commands[0].killed);
  assert.deepEqual(plain(await server.folderSizes("/srv/media", false, false, ["/srv/media/films"])).sizes, { "/srv/media/films": 42 });
  assert.deepEqual(plain(JSON.parse(commands[1].input).skip), ["/srv/media/films"]);
});

test("folder sizes name hidden folders only to sessions that show them", async () => {
  const host = (argv, input) => {
    const request = JSON.parse(input || "{}");
    return { stdout: printed("/srv/media", { "/srv/media/films": 42, ...(request.hidden && { "/srv/media/.secrets": 9 }) }) };
  };
  const { server } = loadServer({ host, env: { ALLOWED_PATHS: "/srv/media" } });
  await server.folderSizes("/srv/media", true);
  const asked = ["/srv/media/films", "/srv/media/.secrets", "/etc/passwd"];
  assert.deepEqual(plain(await server.folderSizes("/srv/media", false, false, asked)).sizes, { "/srv/media/films": 42 });
  assert.deepEqual(plain(await server.folderSizes("/srv/media", true, false, asked)).sizes, { "/srv/media/films": 42, "/srv/media/.secrets": 9 });
});

test("folder sizes leave hidden folders out until hidden files are shown", async () => {
  const { server, root } = tree();
  mkdirSync(path.join(root, ".secrets"));
  writeFileSync(path.join(root, ".secrets", "key"), "x".repeat(1000));
  const shown = Object.keys(plain(await server.folderSizes(root)).sizes);
  assert.ok(shown.includes(path.join(root, "docs")));
  assert.ok(!shown.some((item) => item.includes(".secrets")), "no hidden folder names");
  const all = Object.keys(plain(await server.folderSizes(root, true)).sizes);
  assert.ok(all.includes(path.join(root, ".secrets")));
});
