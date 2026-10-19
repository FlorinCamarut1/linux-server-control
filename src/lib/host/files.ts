// File browsing and editing on the server, confined to the allowed locations.
import { spawn } from "node:child_process";
import path from "node:path";
import { msg, t } from "../i18n";
import { audit } from "./store";
import { allowedRoots, run, runInput, serverSettings, ssh } from "./ssh";
export function isAllowedPath(value: string) {
  return allowedRoots().some((root) => value === root || value.startsWith(root + "/"));
}
// Hidden files and folders, whose names start with a dot (.ssh, .config), stay
// out of the dashboard until a session shows them with the sudo password. Only
// the part of the path below its allowed location counts.
export function isHiddenPath(value: string) {
  const root = allowedRoots().filter((item) => value === item || value.startsWith(item + "/")).sort((a, b) => b.length - a.length)[0];
  return root !== undefined && value.slice(root.length).split("/").some((name) => name.startsWith("."));
}
function refuseHidden(requested: string, resolved: string, hidden: boolean) {
  if (!hidden && (isHiddenPath(resolved) || isHiddenPath(path.posix.normalize(requested))))
    throw Error(t("Hidden files are shown only after Show hidden files"));
}
export async function resolveAllowedDirectory(requested: string, hidden = false) {
  let directory = allowedRoots()[0];
  if (requested) {
    try { directory = (await run(["realpath", "-e", "--", requested])).trim(); }
    catch { throw Error(t("Folder not found")); }
  }
  if (!directory || !isAllowedPath(directory))
    throw Error(t("This folder is outside the allowed locations"));
  refuseHidden(requested || directory, directory, hidden);
  try { await run(["test", "-d", directory]); }
  catch { throw Error(t("Choose a folder")); }
  return directory;
}
export async function resolveSelectedFile(requested: string, hidden = false) {
  let resolved: string;
  try { resolved = (await run(["realpath", "-e", "--", requested])).trim(); }
  catch { throw Error(t("File not found")); }
  if (!isAllowedPath(resolved))
    throw Error(t("The selected file must be inside an allowed location"));
  refuseHidden(requested, resolved, hidden);
  try { await run(["test", "-f", resolved]); }
  catch { throw Error(t("Choose a regular file")); }
  return resolved;
}
const MAX_EDITABLE_FILE_BYTES = 512 * 1024;
const SAVE_SCRIPT = 'temporary=$(mktemp) || exit 1; trap \'rm -f "$temporary"\' EXIT HUP INT TERM; cat > "$temporary" && [ "$(($(wc -c < "$temporary")))" -eq "$2" ] && cat "$temporary" > "$1"';
export async function readEditableFile(requested: string, hidden = false) {
  const resolved = await resolveSelectedFile(requested, hidden);
  const size = Number((await run(["stat", "-c", "%s", resolved])).trim());
  if (!Number.isFinite(size) || size > MAX_EDITABLE_FILE_BYTES)
    throw Error(t("Only text files up to 512 KB can be edited here"));
  // An empty file has no content type yet; it opens so that it can be written.
  const mime = size ? (await run(["file", "--brief", "--mime-type", resolved])).trim() : "text/plain";
  if (!mime.startsWith("text/") && !mime.endsWith("json") && !mime.endsWith("xml"))
    throw Error(t("This file is not a supported text file"));
  return { path: resolved, content: await run(["cat", resolved]) };
}
export async function saveEditableFile(requested: string, content: string, hidden = false) {
  const resolved = await resolveSelectedFile(requested, hidden);
  if (Buffer.byteLength(content, "utf8") > MAX_EDITABLE_FILE_BYTES)
    throw Error(t("Only text files up to 512 KB can be saved here"));
  if (content.includes("\0")) throw Error(t("Binary content cannot be saved here"));
  // The content arrives in a temporary file and replaces the file's own only
  // once all of it is there: a connection lost on the way leaves the file as it
  // was. Writing into the file keeps its owner, permissions and links.
  await runInput(["sh", "-c", SAVE_SCRIPT, "sh", resolved, String(Buffer.byteLength(content, "utf8"))], content, 15000);
  forgetListings([resolved]);
  audit("edited file " + resolved);
}
export async function deleteEditableFile(requested: string) {
  const resolved = await resolveSelectedFile(requested);
  await run(["rm", "-f", "--", resolved]);
  forgetListings([resolved]);
  audit("deleted file " + resolved);
}
export type ScriptBrowserEntry = {
  name: string;
  path: string;
  type: "directory" | "script";
};
// The messages the Python file operation below raises, for translation.
export const PYTHON_MESSAGES = [
  msg("This path is outside the allowed locations"), msg("Allowed locations and their parents cannot be deleted"),
  msg("Deleting symbolic links is not supported"), msg("File or folder not found"), msg("Enter a valid name"),
  msg("Choose an allowed destination folder"), msg("A file or folder with this name already exists"),
  msg("The selected file or folder cannot be changed"), msg("Symbolic links are not supported"),
  msg("Choose a different allowed destination"), msg("A file or folder with this name already exists there"),
  msg("A folder cannot be pasted inside itself"), msg("File operation failed"),
];
const fileOperation = String.raw`
import json, os, sys, shutil, time
request = json.load(sys.stdin)
roots = [os.path.realpath(root) for root in request["roots"]]
target = os.path.realpath(request["path"] or roots[0])
def inside(value, root):
    return value == root or value.startswith(root.rstrip("/") + "/")
def allowed(value):
    return any(inside(value, root) for root in roots)
def protected(value):
    return any(inside(root, value) for root in roots)
show_hidden = bool(request.get("hidden"))
def concealed(value):
    containing = [root for root in roots if inside(value, root)]
    if show_hidden or not containing:
        return False
    return any(name.startswith(".") for name in value[len(max(containing, key=len)):].split("/"))
def reveal(*values):
    for value in values:
        if value and (concealed(value) or concealed(os.path.normpath(value))):
            raise ValueError("Hidden files are shown only after Show hidden files")
if not any(inside(target, root) for root in roots):
    raise ValueError("This path is outside the allowed locations")
reveal(target, request["path"])
if request["action"] == "delete":
    if not request["path"] or protected(target):
        raise ValueError("Allowed locations and their parents cannot be deleted")
    if os.path.islink(request["path"]):
        raise ValueError("Deleting symbolic links is not supported")
    if os.path.isdir(target):
        shutil.rmtree(target)
    elif os.path.isfile(target):
        os.unlink(target)
    else:
        raise ValueError("File or folder not found")
    print(json.dumps({"ok": True}))
elif request["action"] == "create":
    parent = target
    name = request.get("name") or ""
    if not name or name in (".", "..") or "/" in name or "\\" in name or len(name) > 255:
        raise ValueError("Enter a valid name")
    if not allowed(parent) or not os.path.isdir(parent):
        raise ValueError("Choose an allowed destination folder")
    output = os.path.realpath(os.path.join(parent, name))
    reveal(output, os.path.join(parent, name))
    if not allowed(output) or os.path.exists(output):
        raise ValueError("A file or folder with this name already exists")
    if request.get("kind") == "folder":
        os.mkdir(output)
    else:
        open(output, "x").close()
    print(json.dumps({"ok": True, "path": output}))
elif request["action"] in ("copy", "move", "rename"):
    source = os.path.realpath(request.get("source") or "")
    if not source or not allowed(source) or protected(source):
        raise ValueError("The selected file or folder cannot be changed")
    reveal(source, request.get("source"))
    if os.path.islink(request.get("source") or ""):
        raise ValueError("Symbolic links are not supported")
    if not (os.path.isfile(source) or os.path.isdir(source)):
        raise ValueError("File or folder not found")
    if request["action"] == "rename":
        name = request.get("name") or ""
        if not name or name in (".", "..") or "/" in name or "\\" in name or len(name) > 255:
            raise ValueError("Enter a valid name")
        destination = os.path.dirname(source)
        output = os.path.realpath(os.path.join(destination, name))
    else:
        destination = os.path.realpath(request.get("destination") or "")
        if not allowed(destination) or not os.path.isdir(destination):
            raise ValueError("Choose an allowed destination folder")
        output = os.path.realpath(os.path.join(destination, os.path.basename(source)))
    reveal(destination, output)
    if not allowed(output) or output == source:
        raise ValueError("Choose a different allowed destination")
    if os.path.exists(output):
        raise ValueError("A file or folder with this name already exists there")
    if os.path.isdir(source) and inside(destination, source):
        raise ValueError("A folder cannot be pasted inside itself")
    if request["action"] == "copy":
        if os.path.isdir(source):
            shutil.copytree(source, output, symlinks=True)
        else:
            shutil.copy2(source, output, follow_symlinks=False)
    else:
        shutil.move(source, output)
    print(json.dumps({"ok": True, "path": output}))
else:
    # A folder's size is the size of the files below it, as du -b counts them,
    # but with every hard link counted: a folder measures the same whatever is
    # measured with it, and as the sum of the files listed in it.
    def contents(folder):
        # The size of the files in folder, and the folders in it.
        size, folders = 0, []
        try:
            with os.scandir(folder) as items:
                for item in items:
                    try:
                        if item.is_dir(follow_symlinks=False):
                            folders.append(item.path)
                        elif item.is_file(follow_symlinks=False) or item.is_symlink():
                            size += item.stat(follow_symlinks=False).st_size
                    except OSError:
                        pass
        except OSError:
            pass
        return size, folders
    def walk(folder):
        # Everything below folder; a folder reached again, through a bind
        # mount, is not walked again.
        size, waiting, seen = 0, [folder], set()
        while waiting:
            current = waiting.pop()
            try:
                status = os.lstat(current)
            except OSError:
                continue
            if (status.st_dev, status.st_ino) in seen:
                continue
            seen.add((status.st_dev, status.st_ino))
            files, folders = contents(current)
            size += files
            waiting.extend(folders)
        return folder, size
    def walk_each(folders):
        return [walk(folder) for folder in folders]
    def unread():
        # Whether the dashboard stopped reading, as when it ends the measurement.
        import select
        poller = select.poll()
        poller.register(sys.stdout, 0)
        return bool(poller.poll(0))
    def measure(tops, report, seconds):
        # Measures the folders in tops in parallel and reports each as soon as
        # it is measured. Each worker walks whole folders; while there are too
        # few to keep every worker busy, they are split into the folders in
        # them, which are reported too, for when they are opened. Returns
        # whether every folder was measured within the time limit.
        deadline = time.monotonic() + seconds
        workers = min(8, 2 * (os.cpu_count() or 1))
        above, size, left = {}, {}, {}
        def done(folder, amount):
            report(folder, amount)
            parent = above.get(folder)
            if parent is not None:
                size[parent] += amount
                left[parent] -= 1
                if not left[parent]:
                    done(parent, size[parent])
        units = list(tops)
        for _ in range(3):
            if len(units) >= workers * 4 or time.monotonic() > deadline:
                break
            split = []
            for folder in units:
                size[folder], inside = contents(folder)
                left[folder] = len(inside)
                above.update((each, folder) for each in inside)
                split.extend(inside)
            for folder in units:
                if not left[folder]:
                    done(folder, size[folder])
            units = split
        # What is measured is printed at once; forked workers would also print
        # again what is still buffered.
        sys.stdout.flush()
        if not units:
            return True
        pool = None
        if len(units) > 1:
            try:
                import multiprocessing, signal
                # Ending the measurement ends its workers too, at once.
                signal.signal(signal.SIGTERM, lambda *_: sys.exit(1))
                pool = multiprocessing.get_context("fork").Pool(min(workers, len(units)), signal.signal, (signal.SIGTERM, signal.SIG_DFL))
            except Exception:
                pool = None
        if pool is None:
            for folder in units:
                if time.monotonic() > deadline:
                    return False
                done(*walk(folder))
                sys.stdout.flush()
            return True
        # A few folders per task when there are many, each task's when it ends.
        each = max(1, min(8, len(units) // (workers * 8)))
        tasks = [units[start:start + each] for start in range(0, len(units), each)]
        with pool:
            results = pool.imap_unordered(walk_each, tasks)
            for _ in tasks:
                while True:
                    try:
                        measured = results.next(timeout=1)
                        break
                    except multiprocessing.TimeoutError:
                        if time.monotonic() > deadline or unread():
                            return False
                for folder, amount in measured:
                    done(folder, amount)
                sys.stdout.flush()
                if time.monotonic() > deadline:
                    return False
        return True
    if request["action"] == "sizes":
        print(json.dumps({"path": target}), flush=True)
        # Folders with a size the dashboard measured moments ago are skipped.
        only = set(request["only"]) if isinstance(request.get("only"), list) else None
        skip = set(request.get("skip") or [])
        with os.scandir(target) as items:
            tops = [item.path for item in items if item.is_dir(follow_symlinks=False) and (show_hidden or not item.name.startswith("."))]
        tops = sorted((top for top in tops if top not in skip and (only is None or top in only)), key=lambda top: os.path.basename(top).lower())
        below = [0]
        def report(folder, amount):
            # The folders further down, up to a number, for when they are opened.
            if os.path.dirname(folder) != target:
                if below[0] >= 20000 or (not show_hidden and concealed(folder)):
                    return
                below[0] += 1
            sys.stdout.write(json.dumps({"folder": folder, "size": amount}) + "\n")
        complete = measure(tops, report, float(request.get("seconds") or 600))
        print(json.dumps({"complete": complete}), flush=True)
        sys.exit(0)
    entries = []
    ordering = request.get("sort") or "name"
    sizes = request["sizes"] if isinstance(request.get("sizes"), dict) else {}
    with os.scandir(target) as items:
        for item in items:
            if item.name.startswith(".") and not show_hidden:
                continue
            if item.is_dir(follow_symlinks=False):
                kind = "directory"
            elif item.is_file(follow_symlinks=False):
                if request["scripts"] and not item.name.endswith(".sh"):
                    continue
                kind = "script" if request["scripts"] else "file"
            else:
                continue
            status = item.stat(follow_symlinks=False)
            size = sizes.get(item.path) if kind == "directory" else status.st_size
            entries.append({"name": item.name, "path": item.path, "type": kind, "size": size, "modified": int(status.st_mtime)})
    query = str(request.get("search") or "").lower()
    if query:
        entries = [item for item in entries if query in item["name"].lower()]
    missing = [item for item in entries if item["type"] == "directory" and item["size"] is None]
    if ordering == "size" and missing and request.get("measure"):
        # Sorting by size across pages needs every folder's size: those the
        # dashboard has none for, such as a new download, are measured here.
        found = {}
        measure([item["path"] for item in missing], found.__setitem__, float(request["measure"]))
        for item in missing:
            item["size"] = found.get(item["path"])
    if ordering == "size":
        entries.sort(key=lambda item: (item.get("size") is None, -(item.get("size") or 0), item["name"].lower()))
    elif ordering == "date":
        entries.sort(key=lambda item: (-item["modified"], item["name"].lower()))
    else:
        entries.sort(key=lambda item: (item["type"] != "directory", item["name"].lower()))
    offset = max(0, int(request.get("offset") or 0))
    limit = min(5000, max(1, int(request.get("limit") or 100)))
    parent = os.path.dirname(target)
    print(json.dumps({"path": target, "roots": roots,
        "parent": parent if target not in roots and any(inside(parent, root) for root in roots) else None,
        "entries": entries[offset:offset + limit], "total": len(entries), "offset": offset, "limit": limit}))
`;
type FileChange = { ok: boolean; path?: string };
// Copying, moving or deleting a season of films takes far longer than reading a
// folder; ending the wait early would report a failure while it goes on.
const FILE_OPERATION_MS = 30 * 1000, FILE_TRANSFER_MS = 2 * 60 * 60 * 1000;
// Runs the file operation on the server and hands `output` what it prints, as
// it prints it; `stop` ends it.
function fileProcess(request: Record<string, unknown>, timeoutMs: number, output: (chunk: string) => void) {
  const [command, args] = ssh(["python3", "-c", fileOperation]);
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  const ended = new Promise<void>((resolve, reject) => {
    let error = "";
    const timeout = setTimeout(() => { child.kill(); reject(Error(t("File operation timed out"))); }, timeoutMs);
    child.stdout.on("data", (chunk) => output(String(chunk)));
    child.stderr.on("data", (chunk) => { error += chunk; });
    child.on("error", (reason) => { clearTimeout(timeout); reject(reason); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      // Python reports "ValueError: <message>"; the messages are listed in PYTHON_MESSAGES.
      // Newer Pythons may colour it; the colour codes are dropped.
      const last = (error.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").pop() || "").replace(/^\w+Error: /, "");
      if (code !== 0) reject(Error(t(last || "File operation failed")));
      else resolve();
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ ...request, roots: allowedRoots() }));
  });
  return { ended, stop: () => { child.kill(); } };
}
async function remoteFileOperation<T = Record<string, unknown>>(request: Record<string, unknown>, timeoutMs = FILE_OPERATION_MS) {
  let output = "";
  await fileProcess(request, timeoutMs, (chunk) => { output += chunk; }).ended;
  try { return JSON.parse(output) as T; } catch { throw Error(t("Invalid file response")); }
}
export function browseScripts(requested = "") {
  return remoteFileOperation({ path: requested, action: "browse", scripts: true, hidden: false });
}
// A folder is listed whole when its first page is requested, and its further
// pages are cut from that listing: the server then lists, measures (when sorted
// by size) and sorts the folder once instead of once per page, and the pages
// belong to the same listing. Opening the first page again lists again, and any
// change made through the dashboard forgets the listings. A folder with more
// entries than this is paged on the server instead.
const LISTING_MAX_ENTRIES = 5000;
const LISTING_TTL_MS = 5 * 60 * 1000;
const LISTINGS_KEPT = 8;
type ListedEntry = { name: string; path: string; type: string; size: number | null; modified?: number; stale?: boolean };
type Listing = { path: string; roots: string[]; parent: string | null; entries: ListedEntry[]; total: number };
const listings = new Map<string, { at: number; listing: Listing }>();
// After a change through the dashboard at these paths; `resized` when the
// folders they are in changed size too.
function forgetListings(changed: string[], resized = true) {
  listings.clear();
  forgetSizes(changed.filter(Boolean).map((value) => path.posix.normalize(value).replace(/(.)\/$/, "$1")), resized);
}
// Cached listings and measurements belong to one server and its allowed locations.
const cacheKey = (...parts: unknown[]) => JSON.stringify([serverSettings().sshTarget, allowedRoots(), ...parts]);
export async function browseFiles(requested = "", options: { search?: string; sort?: string; offset?: number; limit?: number; hidden?: boolean; fresh?: boolean } = {}) {
  const search = options.search || "", sort = options.sort || "name", hidden = !!options.hidden;
  const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
  const limit = Math.min(1000, Math.max(1, Math.floor(Number(options.limit) || 100)));
  const key = cacheKey(requested, search, sort, hidden);
  // Folders get the sizes measured so far, also when their listing is kept.
  const page = (listing: Listing) => ({ ...listing, entries: listing.entries.slice(offset, offset + limit).map(withSize), offset, limit });
  // The page's Refresh button lists again whichever page is open.
  const kept = offset > 0 && !options.fresh ? listings.get(key) : undefined;
  if (kept && Date.now() - kept.at < LISTING_TTL_MS) return page(kept.listing);
  // Sorting by size across pages needs every folder's size first: the folder's
  // measurement, for a while. The server measures the folders it has no size
  // for once the measurement ended, or all of them if it failed.
  let sizes: Record<string, number> | undefined, measure = 0;
  if (sort === "size") {
    const measured = await folderSizes(requested, hidden, options.fresh).catch(() => undefined);
    sizes = measured?.sizes;
    measure = !measured ? 20 : measured.complete ? 8 : 0;
  }
  const request = { path: requested, action: "browse", scripts: false, search, sort, hidden, ...(sizes && { sizes }), ...(measure && { measure }) };
  const listing = await remoteFileOperation<Listing>({ ...request, offset: 0, limit: LISTING_MAX_ENTRIES });
  for (const entry of sort === "size" ? listing.entries : [])
    if (entry.type === "directory" && entry.size !== null && !(sizes && entry.path in sizes)) keepSize(entry.path, entry.size);
  listings.delete(key);
  if (listing.total > listing.entries.length)
    return offset === 0 ? page(listing) : remoteFileOperation({ ...request, offset, limit });
  listings.set(key, { at: Date.now(), listing });
  for (const oldest of listings.keys()) {
    if (listings.size <= LISTINGS_KEPT) break;
    listings.delete(oldest);
  }
  return page(listing);
}
// Folder sizes. Measuring a folder walks everything below it, which on a media
// disk takes seconds. The server measures the folders in a folder in parallel
// and prints each size as soon as it has it, with the sizes of the folders
// below them that it measured on the way. Every size is kept, by folder, for
// coming back and for opening the folders below:
// - A size measured in the last 5 minutes is used as it is.
// - An older one, up to a day old, is shown as stale while it is measured again.
// - Refresh measures every folder in the folder again, and their sizes are stale
//   until then. Clicks while that measurement starts share it.
// - A change through the dashboard makes the sizes of the folders it is in stale,
//   forgets those below it, and stops measuring those folders.
// - A measurement that nobody waits for is stopped after 3 seconds; the sizes it
//   printed are kept, and the folders it did not reach are measured when asked.
type KnownSize = { size: number; at: number };
const SIZE_FRESH_MS = 5 * 60 * 1000, SIZE_KEPT_MS = 24 * 60 * 60 * 1000, SIZES_KEPT = 50000;
const knownSizes = new Map<string, KnownSize>();
let sizesServer = "";
function sizesKept() {
  const server = cacheKey();
  if (server !== sizesServer) {
    knownSizes.clear();
    sizesServer = server;
  }
  return knownSizes;
}
function knownSize(folder: string) {
  const known = sizesKept().get(folder);
  return known && Date.now() - known.at < SIZE_KEPT_MS ? known : undefined;
}
const isFresh = (known?: KnownSize) => !!known && Date.now() - known.at < SIZE_FRESH_MS;
function keepSize(folder: string, size: number) {
  const kept = sizesKept();
  kept.delete(folder);
  kept.set(folder, { size, at: Date.now() });
  for (const oldest of kept.keys()) {
    if (kept.size <= SIZES_KEPT) break;
    kept.delete(oldest);
  }
}
function withSize(entry: ListedEntry): ListedEntry {
  const known = entry.type === "directory" ? knownSize(entry.path) : undefined;
  if (!known) return entry;
  return isFresh(known) ? { ...entry, size: known.size } : { ...entry, size: known.size, stale: true };
}
const within = (value: string, folder: string) => value === folder || value.startsWith(folder === "/" ? "/" : folder + "/");
// The folders directly in folder that have a size.
const keptFolders = (folder: string) => [...sizesKept().keys()].filter((kept) => path.posix.dirname(kept) === folder);
// The sizes measured before `before`, of the folders in folder, become stale.
function makeStale(folder: string, before: number) {
  const stale = Date.now() - SIZE_FRESH_MS;
  for (const kept of keptFolders(folder)) {
    const known = sizesKept().get(kept)!;
    if (known.at < before) known.at = Math.min(known.at, stale);
  }
}
// Without paths, anything may have changed.
function forgetSizes(changed: string[], resized: boolean) {
  const below = (folder: string) => !changed.length || changed.some((value) => within(folder, value));
  const containing = (folder: string) => resized && changed.some((value) => within(value, folder));
  const stale = Date.now() - SIZE_FRESH_MS;
  for (const [folder, known] of sizesKept()) {
    if (below(folder)) sizesKept().delete(folder);
    else if (containing(folder)) known.at = Math.min(known.at, stale);
  }
  const related = (measurement: Measurement) => below(measurement.folder ?? measurement.guess) || containing(measurement.folder ?? measurement.guess);
  for (const measurement of running) if (related(measurement)) measurement.stop();
  for (const [key, measurement] of measurements) if (related(measurement)) measurements.delete(key);
}
type Measurement = {
  // The folder as requested, normalized, and as the server resolved it.
  guess: string;
  folder?: string;
  every: boolean;
  started: number;
  running: boolean;
  complete?: boolean;
  error?: unknown;
  // Requests waiting for it, and when the last one ended.
  waiting: number;
  wanted: number;
  wake: Set<() => void>;
  timer?: ReturnType<typeof setTimeout>;
  stop: () => void;
};
// The latest measurement of each folder, as requested and as resolved, and those running.
const measurements = new Map<string, Measurement>();
const running = new Set<Measurement>();
const MEASUREMENT_SHARED_MS = 10 * 1000, MEASUREMENT_ABANDONED_MS = 3000, MEASUREMENT_SECONDS = 600;
function keepMeasurement(key: string, measurement: Measurement) {
  measurements.delete(key);
  measurements.set(key, measurement);
  for (const oldest of measurements.keys()) {
    if (measurements.size <= LISTINGS_KEPT * 2) break;
    measurements.delete(oldest);
  }
}
function wake(measurement: Measurement) {
  for (const waiting of measurement.wake) waiting();
  measurement.wake.clear();
}
// Resolves on the measurement's next size or end, or after `ms`.
const news = (measurement: Measurement, ms: number) => new Promise<void>((resolve) => {
  const timer = setTimeout(done, ms);
  function done() {
    clearTimeout(timer);
    measurement.wake.delete(done);
    resolve();
  }
  measurement.wake.add(done);
});
// One timer per measurement; a timer that fires before the time is up, by the
// clock, waits for the rest instead of letting the measurement run on.
function abandonLater(measurement: Measurement, ms = MEASUREMENT_ABANDONED_MS) {
  clearTimeout(measurement.timer);
  measurement.timer = setTimeout(() => {
    if (!measurement.running || measurement.waiting) return;
    const left = measurement.wanted + MEASUREMENT_ABANDONED_MS - Date.now();
    if (left > 0) abandonLater(measurement, left);
    else measurement.stop();
  }, ms);
  measurement.timer.unref?.();
}
// Measures the folders in a folder: all of them, those in `only`, or those
// without a fresh size.
function measure(requested: string, hidden: boolean, every: boolean, only?: string[]) {
  const guess = requested ? path.posix.normalize(requested).replace(/(.)\/$/, "$1") : allowedRoots()[0];
  const started = Date.now();
  if (every) makeStale(guess, started);
  const skip = every || only ? [] : keptFolders(guess).filter((folder) => isFresh(knownSize(folder)));
  const measurement: Measurement = { guess, every, started, running: true, waiting: 0, wanted: started, wake: new Set(), stop: () => {} };
  let unread = "";
  const operation = fileProcess({ path: requested, action: "sizes", scripts: false, hidden, skip, ...(only && { only }), seconds: MEASUREMENT_SECONDS }, (MEASUREMENT_SECONDS + 30) * 1000, (chunk) => {
    if (!measurement.running) return;
    const lines = (unread + chunk).split("\n");
    unread = lines.pop() || "";
    for (const line of lines) {
      let printed: { path?: unknown; folder?: unknown; size?: unknown; complete?: unknown };
      try { printed = JSON.parse(line); } catch { continue; }
      if (typeof printed.folder === "string" && typeof printed.size === "number") keepSize(printed.folder, printed.size);
      else if (typeof printed.path === "string") {
        measurement.folder = printed.path;
        if (every && printed.path !== guess) makeStale(printed.path, started);
        keepMeasurement(cacheKey(printed.path, hidden), measurement);
      } else if (typeof printed.complete === "boolean") measurement.complete = printed.complete;
    }
    wake(measurement);
  });
  const end = (error?: unknown) => {
    if (!measurement.running) return;
    measurement.running = false;
    measurement.error = error;
    running.delete(measurement);
    wake(measurement);
  };
  operation.ended.then(() => end(), (error) => end(error));
  measurement.stop = () => {
    if (!measurement.running) return;
    operation.stop();
    end();
  };
  running.add(measurement);
  keepMeasurement(cacheKey(requested, hidden), measurement);
  abandonLater(measurement);
  return measurement;
}
// The measurement that answers for a folder now: the one running, a complete
// one that started in the last 5 minutes (its sizes are all fresh), or a new one.
function measurementFor(requested: string, hidden: boolean, fresh = false) {
  const kept = measurements.get(cacheKey(requested, hidden));
  if (kept?.running) {
    if (!fresh || (kept.every && Date.now() - kept.started < MEASUREMENT_SHARED_MS)) return kept;
    kept.stop();
  } else if (kept && !fresh && kept.complete && Date.now() - kept.started < SIZE_FRESH_MS) return kept;
  return measure(requested, hidden, fresh);
}
// Starts measuring the folders in a folder, for the requests for their sizes that follow.
export function startFolderSizes(requested: string, hidden = false, fresh = false) {
  measurementFor(requested, hidden, fresh);
}
type FolderSizes = { path: string; sizes: Record<string, number>; complete: boolean };
const SIZES_WAIT_MS = 1500, SIZES_GATHER_MS = 200, SORTED_WAIT_MS = 20 * 1000;
// The sizes measured of the folders in a folder:
// - With `expected` (the folders shown), once one of them is measured (and
//   those measured just after it), all are, or `wait` passes. `complete` says
//   that no more will come: folders the measurement did not reach, such as one
//   made since, are measured once before.
// - Without, once the measurement ends or `wait` passes, for every folder in it.
export async function folderSizes(requested: string, hidden = false, fresh = false, expected?: string[], wait = expected ? SIZES_WAIT_MS : SORTED_WAIT_MS): Promise<FolderSizes> {
  let measurement = measurementFor(requested, hidden, fresh), retried = false;
  let until = Date.now() + wait;
  const visible = (folder: string) => hidden || !path.posix.basename(folder).startsWith(".");
  const asked = () => {
    const { folder } = measurement;
    return folder === undefined ? [] : (expected ?? keptFolders(folder)).filter((each) => path.posix.dirname(each) === folder && visible(each));
  };
  const result = (complete: boolean): FolderSizes => {
    const sizes: Record<string, number> = {};
    for (const folder of asked()) {
      const known = knownSize(folder);
      if (known && isFresh(known)) sizes[folder] = known.size;
    }
    return { path: measurement.folder ?? measurement.guess, sizes, complete };
  };
  const missing = () => asked().filter((folder) => !isFresh(knownSize(folder)));
  // Those without a size when this request came: all of them, before the
  // server named the folder.
  let before = measurement.folder === undefined ? undefined : missing().length;
  measurement.waiting++;
  try {
    for (;;) {
      if (measurement.error) throw measurement.error;
      if (expected && measurement.folder !== undefined) {
        const left = missing().length;
        if (!left) return result(true);
        // Once one is measured, the next few are waited for only a moment.
        before ??= asked().length;
        if (left < before) until = Math.min(until, Date.now() + SIZES_GATHER_MS);
      }
      if (!measurement.running) {
        // Stopped before it named the folder, or without the folders asked about.
        if (!retried && (measurement.folder === undefined || (expected && missing().length))) {
          const only = measurement.folder === undefined ? undefined : missing();
          measurement.waiting--;
          measurement = only ? measure(requested, hidden, false, only) : measure(requested, hidden, fresh);
          measurement.waiting++;
          retried = true;
          continue;
        }
        return result(expected ? true : measurement.complete === true);
      }
      if (Date.now() >= until) return result(false);
      await news(measurement, until - Date.now());
    }
  } finally {
    measurement.waiting--;
    measurement.wanted = Date.now();
    if (!measurement.waiting) abandonLater(measurement);
  }
}
export async function deleteFolder(requested: string) {
  try { await remoteFileOperation({ path: requested, action: "delete" }, FILE_TRANSFER_MS); }
  finally { forgetListings([requested]); }
  audit("deleted folder " + requested);
}
export async function changeFile(
  action: "delete" | "copy" | "move" | "rename",
  source: string,
  destination = "",
  name = "",
  hidden = false,
) {
  let output = "";
  try {
    const result = await remoteFileOperation<FileChange>({
      path: source,
      action,
      source,
      destination,
      name,
      hidden,
    }, action === "rename" ? FILE_OPERATION_MS : FILE_TRANSFER_MS);
    output = result.path || "";
    audit(`${action} ${source}${result.path ? " -> " + result.path : ""}`);
    return result;
  } finally {
    // A failed or interrupted change may have changed the folders too.
    output ||= action === "rename" ? path.posix.join(path.posix.dirname(source), name) : destination && path.posix.join(destination, path.posix.basename(source));
    forgetListings([action === "copy" ? "" : source, output]);
  }
}
export async function createFileOrFolder(directory: string, name: string, kind: "file" | "folder", hidden = false) {
  const result = await remoteFileOperation<FileChange>({ path: directory, action: "create", name, kind, hidden });
  // Empty, it leaves the sizes of the folders it is in as they were.
  forgetListings([result.path || path.posix.join(directory, name)], false);
  audit(`created ${kind} ${result.path}`); return result;
}
