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
  forgetListings();
  audit("edited file " + resolved);
}
export async function deleteEditableFile(requested: string) {
  const resolved = await resolveSelectedFile(requested);
  await run(["rm", "-f", "--", resolved]);
  forgetListings();
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
import json, os, sys, shutil, subprocess
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
    def measure(folders, whole, limit):
        # The sizes du reports (the folder and each folder in it when whole),
        # without hidden ones, and whether du finished within its time limit.
        sizes = {}
        try:
            measured = subprocess.run(
                ["du", "-b", "--max-depth=1" if whole else "-s", "--", *folders],
                capture_output=True, text=True, timeout=limit, check=False)
            output, complete = measured.stdout, True
        except subprocess.TimeoutExpired as expired:
            # What du printed in time; its last line may be cut short.
            output, complete = expired.stdout or "", False
            if isinstance(output, bytes):
                output = output.decode("utf-8", "replace")
            output = output[:output.rfind("\n") + 1]
        except OSError:
            return sizes, False
        for line in output.splitlines():
            amount, _, name = line.partition("\t")
            if amount.isdigit() and name and not concealed(os.path.realpath(name)):
                sizes[os.path.realpath(name)] = int(amount)
        return sizes, complete
    entries = []
    sizes = {}
    if request["action"] == "sizes":
        sizes, complete = measure([target], True, 20)
        print(json.dumps({"path": target, "sizes": sizes, "complete": complete}))
        sys.exit(0)
    ordering = request.get("sort") or "name"
    measured = isinstance(request.get("sizes"), dict)
    if ordering == "size":
        # Sorting by size across pages needs every folder's size first: the
        # dashboard's measurement, or one taken here.
        sizes = request["sizes"] if measured else measure([target], True, 20)[0]
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
            size = sizes.get(os.path.realpath(item.path)) if kind == "directory" else status.st_size
            entries.append({"name": item.name, "path": item.path, "type": kind, "size": size, "modified": int(status.st_mtime)})
    query = str(request.get("search") or "").lower()
    if query:
        entries = [item for item in entries if query in item["name"].lower()]
    missing = [item for item in entries if item["type"] == "directory" and item["size"] is None]
    if ordering == "size" and measured and missing:
        # Folders made since the dashboard measured, such as a new download.
        found = measure([item["path"] for item in missing], False, 8)[0]
        for item in missing:
            item["size"] = found.get(os.path.realpath(item["path"]))
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
async function remoteFileOperation<T = Record<string, unknown>>(request: Record<string, unknown>, timeoutMs = FILE_OPERATION_MS) {
  const [command, args] = ssh(["python3", "-c", fileOperation]);
  return new Promise<T>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let output = "", error = "";
    const timeout = setTimeout(() => { child.kill(); reject(Error(t("File operation timed out"))); }, timeoutMs);
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { error += chunk; });
    child.on("error", (reason) => { clearTimeout(timeout); reject(reason); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      // Python reports "ValueError: <message>"; the messages are listed in PYTHON_MESSAGES.
      // Newer Pythons may colour it; the colour codes are dropped.
      const last = (error.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").pop() || "").replace(/^\w+Error: /, "");
      if (code !== 0) return reject(Error(t(last || "File operation failed")));
      try { resolve(JSON.parse(output)); } catch { reject(Error(t("Invalid file response"))); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ ...request, roots: allowedRoots() }));
  });
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
type Listing = { path: string; roots: string[]; parent: string | null; entries: unknown[]; total: number };
const listings = new Map<string, { at: number; listing: Listing }>();
// Changes made through the dashboard; a measurement that started before one is
// not kept under another name once it ends.
let changes = 0;
function forgetListings() {
  changes++;
  listings.clear();
  measurements.clear();
}
// Cached listings and measurements belong to one server and its allowed locations.
const cacheKey = (...parts: unknown[]) => JSON.stringify([serverSettings().sshTarget, allowedRoots(), ...parts]);
export async function browseFiles(requested = "", options: { search?: string; sort?: string; offset?: number; limit?: number; hidden?: boolean; fresh?: boolean } = {}) {
  const search = options.search || "", sort = options.sort || "name", hidden = !!options.hidden;
  const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
  const limit = Math.min(1000, Math.max(1, Math.floor(Number(options.limit) || 100)));
  const key = cacheKey(requested, search, sort, hidden);
  const page = (listing: Listing) => ({ ...listing, entries: listing.entries.slice(offset, offset + limit), offset, limit });
  // The page's Refresh button lists again whichever page is open.
  const kept = offset > 0 && !options.fresh ? listings.get(key) : undefined;
  if (kept && Date.now() - kept.at < LISTING_TTL_MS) return page(kept.listing);
  // Sorting by size uses the folder's measurement, which the folder sizes share,
  // instead of measuring the folder again; without a whole one it is measured
  // while listing.
  const measured = sort === "size" ? await folderSizes(requested, hidden, options.fresh).catch(() => undefined) : undefined;
  const sizes = measured?.complete !== false ? measured?.sizes : undefined;
  const request = { path: requested, action: "browse", scripts: false, search, sort, hidden, ...(sizes && { sizes }) };
  const listing = await remoteFileOperation<Listing>({ ...request, offset: 0, limit: LISTING_MAX_ENTRIES });
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
// Measuring a folder walks everything below it (du), which on a media disk takes
// seconds. A measurement is kept as long as a listing, under the folder as
// requested and as it resolved (so that "" and the first allowed location share
// one), and requests that arrive while it runs share it: turning a page,
// searching, or coming back to a folder does not measure it again.
// - `fresh` (the page's Refresh button) measures again, unless a measurement that
//   started moments ago is still running.
// - A folder missing from a kept measurement, such as a new download, has the
//   folder measured again.
// - One that du's time limit cut short is not kept.
// - Any change made through the dashboard forgets the measurements.
type FolderSizes = { path: string; sizes: Record<string, number>; complete?: boolean };
type Measurement = { at: number; running: boolean; sizes: Promise<FolderSizes> };
const measurements = new Map<string, Measurement>();
const MEASUREMENT_SHARED_MS = 10 * 1000;
function keepMeasurement(key: string, measurement: Measurement) {
  measurements.delete(key);
  measurements.set(key, measurement);
  // Two names for each of the folders kept.
  for (const oldest of measurements.keys()) {
    if (measurements.size <= LISTINGS_KEPT * 2) break;
    measurements.delete(oldest);
  }
}
function forgetMeasurement(measurement: Measurement) {
  for (const [key, kept] of measurements) if (kept === measurement) measurements.delete(key);
}
function measure(requested: string, hidden: boolean) {
  const before = changes;
  const measurement: Measurement = { at: Date.now(), running: true, sizes: Promise.resolve({ path: "", sizes: {} }) };
  measurement.sizes = remoteFileOperation<FolderSizes>({ path: requested, action: "sizes", scripts: false, hidden }).then((result) => {
    measurement.running = false;
    if (result.complete === false) forgetMeasurement(measurement);
    else if (result.path !== requested && changes === before) keepMeasurement(cacheKey(result.path, hidden), measurement);
    return result;
  }, (error) => {
    measurement.running = false;
    forgetMeasurement(measurement);
    throw error;
  });
  keepMeasurement(cacheKey(requested, hidden), measurement);
  return measurement.sizes;
}
export async function folderSizes(requested: string, hidden = false, fresh = false, expected: string[] = []) {
  const kept = measurements.get(cacheKey(requested, hidden));
  const age = kept ? Date.now() - kept.at : Infinity;
  if (!kept || age >= LISTING_TTL_MS || (fresh && !(kept.running && age < MEASUREMENT_SHARED_MS))) return measure(requested, hidden);
  const result = await kept.sizes;
  if (age >= MEASUREMENT_SHARED_MS && expected.some((folder) => !(folder in result.sizes))) return measure(requested, hidden);
  return result;
}
export async function deleteFolder(requested: string) {
  try { await remoteFileOperation({ path: requested, action: "delete" }, FILE_TRANSFER_MS); }
  finally { forgetListings(); }
  audit("deleted folder " + requested);
}
export async function changeFile(
  action: "delete" | "copy" | "move" | "rename",
  source: string,
  destination = "",
  name = "",
  hidden = false,
) {
  let result: FileChange;
  // A failed or interrupted change may have changed the folder too.
  try {
    result = await remoteFileOperation<FileChange>({
      path: source,
      action,
      source,
      destination,
      name,
      hidden,
    }, action === "rename" ? FILE_OPERATION_MS : FILE_TRANSFER_MS);
  } finally {
    forgetListings();
  }
  audit(`${action} ${source}${result.path ? " -> " + result.path : ""}`);
  return result;
}
export async function createFileOrFolder(directory: string, name: string, kind: "file" | "folder", hidden = false) {
  const result = await remoteFileOperation<FileChange>({ path: directory, action: "create", name, kind, hidden });
  forgetListings();
  audit(`created ${kind} ${result.path}`); return result;
}
