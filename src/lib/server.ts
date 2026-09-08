import { execFileSync, spawn } from "node:child_process";
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  randomUUID,
} from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  appendFileSync,
  openSync,
} from "node:fs";
import path from "node:path";
export const DATA = process.env.DATA_DIR || "/app/data",
  TARGET = process.env.SSH_TARGET || "localhost",
  ROOT = process.env.SCRIPT_ROOT || "/home",
  REMOTE = process.env.REMOTE_LOGS || "/tmp/media-dashboard";
export const ALLOWED_ROOTS = [
  ...new Set(
    (process.env.ALLOWED_PATHS || ROOT)
      .split(",")
      .map((item) => item.trim().replace(/\/$/, ""))
      .filter((item) => item.startsWith("/")),
  ),
];
mkdirSync(DATA, { recursive: true });
export type Script = {
  id: string;
  name: string;
  path: string;
  cron: string;
  folder?: string;
  argumentHint?: string;
  runOptions?: RunOption[];
};
export type RunOption = {
  label: string;
  value: string;
  description: string;
  needsFile?: boolean;
};
export type Schedule = {
  id: string;
  scriptId: string;
  expression: string;
  label: string;
  enabled: boolean;
  runAs?: "user" | "root";
  command?: string;
};
export const sessions = new Map<string, { device: string; expires: number }>();
export function read<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path.join(DATA, name + ".json"), "utf8"));
  } catch {
    return fallback;
  }
}
export function save(name: string, value: unknown) {
  const p = path.join(DATA, name + ".json"),
    t = p + ".tmp";
  writeFileSync(t, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(t, p);
}
const ssh = (args: string[]): [string, string[]] =>
  process.env.SSH_TARGET
    ? [
        "ssh",
        [
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=8",
          "-o",
          "StrictHostKeyChecking=yes",
          "-i",
          "/run/ssh/id_ed25519",
          "-o",
          "UserKnownHostsFile=/run/ssh/known_hosts",
          TARGET,
          shell(args),
        ],
      ]
    : [args[0], args.slice(1)];
export function shell(args: string[]) {
  return args.map((x) => "'" + x.replaceAll("'", "'\\''") + "'").join(" ");
}
export function run(args: string[], timeout = 30000) {
  const [c, a] = ssh(args);
  return execFileSync(c, a, { encoding: "utf8", timeout, maxBuffer: 4e6 });
}
export function runInput(args: string[], input: string, timeout = 30000) {
  const [c, a] = ssh(args);
  return execFileSync(c, a, { encoding: "utf8", input, timeout, maxBuffer: 4e6 });
}
type CronUser = "user" | "root";
const rootCronHelper = "/usr/local/sbin/media-dashboard-root-cron";
export function cron(user: CronUser = "user") {
  try {
    return user === "root"
      ? run(["sudo", "-n", rootCronHelper, "list"])
      : run(["crontab", "-l"]);
  } catch {
    return "";
  }
}
export function rootCronStatus() {
  try {
    return {
      available: true,
      cron: run(["sudo", "-n", rootCronHelper, "list"]),
      system: run(["sudo", "-n", rootCronHelper, "system-list"]),
    };
  } catch {
    return { available: false, cron: "", system: "" };
  }
}
export function scripts() {
  return read<Script[]>("scripts", []);
}
export function folders() {
  const stored = read<string[]>("folders", []);
  const inferred = scripts()
    .map((script) => script.folder || "")
    .filter(Boolean);
  return [...new Set([...stored, ...inferred])].sort((a, b) =>
    a.localeCompare(b),
  );
}
export function addFolder(input: string) {
  const name = input.trim().replace(/\s+/g, " ").slice(0, 60);
  if (!name) throw Error("Enter a folder name");
  if (name === "Unfiled") throw Error("This folder name is reserved");
  if (/[\r\n]/.test(name)) throw Error("The folder name must be one line");
  const all = folders();
  if (!all.includes(name)) save("folders", [...all, name]);
}
export function schedules(): Schedule[] {
  const stored = read<Schedule[]>("schedules", []).map((item) => ({
    ...item,
    runAs: item.runAs === "root" ? ("root" as const) : ("user" as const),
  }));
  if (stored.length) return stored;
  return scripts()
    .filter((script) => script.cron)
    .map((script) => ({
      id: `legacy-${script.id}`,
      scriptId: script.id,
      expression: script.cron,
      label: "Imported schedule",
      enabled: true,
      runAs: "user",
    }));
}
export function validCron(x: string) {
  if (!x) return;
  if (x === "@reboot") return;
  const f = x.split(/\s+/);
  if (
    f.length !== 5 ||
    f.some(
      (v) => !/^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/.test(v),
    )
  )
    throw Error("Invalid cron expression");
}
export function syncCron(items: Schedule[], extraUsers: CronUser[] = []) {
  run(["mkdir", "-p", REMOTE]);
  const available = scripts();
  const users = new Set<CronUser>([
    ...items.map((item) => item.runAs || "user"),
    ...extraUsers,
  ]);
  for (const user of users) {
    const old = cron(user);
    save(`cron-backup-${user}-${Date.now()}`, old);
    const lines = old
      .split("\n")
      .filter((line) => !line.includes("# media-dashboard:"));
    for (const schedule of items.filter(
      (item) => (item.runAs || "user") === user,
    )) {
      const script = available.find((item) => item.id === schedule.scriptId);
      if (schedule.enabled && (script || schedule.command))
        lines.push(
          schedule.command
            ? `${schedule.expression} ${schedule.command} # media-dashboard:${schedule.id}`
            : `${schedule.expression} /bin/bash ${shell([script!.path])} >> ${shell([REMOTE + "/" + script!.id + ".log"])} 2>&1 # media-dashboard:${schedule.id}`,
        );
    }
    const data = lines.join("\n") + "\n";
    if (user === "root")
      runInput(["sudo", "-n", rootCronHelper, "install"], data, 15000);
    else runInput(["crontab", "-"], data, 15000);
  }
}
export function hash(password: string, salt: string) {
  return scryptSync(password, Buffer.from(salt, "hex"), 64, {
    N: 16384,
    r: 8,
    p: 1,
  }).toString("hex");
}
export function secureEqual(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function digest(x: string) {
  return createHash("sha256").update(x).digest("hex");
}
export function token() {
  return randomBytes(32).toString("base64url");
}
export function audit(x: string) {
  appendFileSync(
    path.join(DATA, "audit.log"),
    new Date().toISOString() + " " + x + "\n",
  );
}
function parseArguments(value: string) {
  if (value.length > 2000 || /[\r\n]/.test(value))
    throw Error("Arguments must be a single line shorter than 2,000 characters");
  const args: string[] = [];
  let current = "", quote = "", escaped = false;
  for (const char of value) {
    if (escaped) { current += char; escaped = false; }
    else if (char === "\\") escaped = true;
    else if (quote) {
      if (char === quote) quote = "";
      else current += char;
    } else if (char === "'" || char === '"') quote = char;
    else if (/\s/.test(char)) {
      if (current) { args.push(current); current = ""; }
    } else current += char;
  }
  if (escaped || quote) throw Error("Arguments contain an unfinished quote or escape");
  if (current) args.push(current);
  if (args.length > 30 || args.some((arg) => arg.length > 500))
    throw Error("Too many or overly long arguments");
  return args;
}
function isAllowedPath(value: string) {
  return ALLOWED_ROOTS.some((root) => value === root || value.startsWith(root + "/"));
}
function resolveAllowedDirectory(requested: string) {
  const directory = requested
    ? run(["realpath", "-e", requested]).trim()
    : ALLOWED_ROOTS[0];
  if (!directory || !isAllowedPath(directory))
    throw Error("This folder is outside the allowed locations");
  run(["test", "-d", directory]);
  return directory;
}
function resolveSelectedFile(requested: string) {
  const resolved = run(["realpath", "-e", requested]).trim();
  if (!isAllowedPath(resolved))
    throw Error("The selected file must be inside an allowed location");
  run(["test", "-f", resolved]);
  return resolved;
}
const MAX_EDITABLE_FILE_BYTES = 512 * 1024;
export function readEditableFile(requested: string) {
  const resolved = resolveSelectedFile(requested);
  const size = Number(run(["stat", "-c", "%s", resolved]).trim());
  if (!Number.isFinite(size) || size > MAX_EDITABLE_FILE_BYTES)
    throw Error("Only text files up to 512 KB can be edited here");
  const mime = run(["file", "--brief", "--mime-type", resolved]).trim();
  if (!mime.startsWith("text/") && !mime.endsWith("json") && !mime.endsWith("xml"))
    throw Error("This file is not a supported text file");
  return { path: resolved, content: run(["cat", resolved]) };
}
export function saveEditableFile(requested: string, content: string) {
  const resolved = resolveSelectedFile(requested);
  if (Buffer.byteLength(content, "utf8") > MAX_EDITABLE_FILE_BYTES)
    throw Error("Only text files up to 512 KB can be saved here");
  if (content.includes("\0")) throw Error("Binary content cannot be saved here");
  runInput(["sh", "-c", 'cat > "$1"', "sh", resolved], content, 15000);
  audit("edited file " + resolved);
}
export function deleteEditableFile(requested: string) {
  const resolved = resolveSelectedFile(requested);
  run(["rm", "-f", "--", resolved]);
  audit("deleted file " + resolved);
}
export function runScript(s: Script, rawArguments = "", selectedFile = "") {
  const scriptArguments = parseArguments(rawArguments);
  if (selectedFile) {
    const fileIndex = scriptArguments.indexOf("--file");
    scriptArguments.splice(
      fileIndex >= 0 ? fileIndex + 1 : scriptArguments.length,
      0,
      resolveSelectedFile(selectedFile),
    );
  }
  const log = path.join(DATA, s.id + ".log"),
    [cmd, args] = ssh(["/bin/bash", s.path, ...scriptArguments]);
  const out = openSync(log, "a");
  const child = spawn(cmd, args, {
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  audit("run script " + s.name);
}
export type ScriptBrowserEntry = {
  name: string;
  path: string;
  type: "directory" | "script";
};
const fileOperation = String.raw`
import json, os, sys, shutil
request = json.load(sys.stdin)
roots = [os.path.realpath(root) for root in request["roots"]]
target = os.path.realpath(request["path"] or roots[0])
def inside(value, root):
    return value == root or value.startswith(root.rstrip("/") + "/")
def allowed(value):
    return any(inside(value, root) for root in roots)
def protected(value):
    return any(inside(root, value) for root in roots)
if not any(inside(target, root) for root in roots):
    raise ValueError("This path is outside the allowed locations")
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
elif request["action"] in ("copy", "move", "rename"):
    source = os.path.realpath(request.get("source") or "")
    if not source or not allowed(source) or protected(source):
        raise ValueError("The selected file or folder cannot be changed")
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
    entries = []
    with os.scandir(target) as items:
        for item in items:
            if item.is_dir(follow_symlinks=False):
                kind = "directory"
            elif item.is_file(follow_symlinks=False):
                if request["scripts"] and not item.name.endswith(".sh"):
                    continue
                kind = "script" if request["scripts"] else "file"
            else:
                continue
            entries.append({"name": item.name, "path": item.path, "type": kind})
    entries.sort(key=lambda item: (item["type"] != "directory", item["name"].lower()))
    parent = os.path.dirname(target)
    print(json.dumps({"path": target, "roots": roots,
        "parent": parent if target not in roots and any(inside(parent, root) for root in roots) else None,
        "entries": entries[:300]}))
`;
async function remoteFileOperation(request: Record<string, unknown>) {
  const [command, args] = ssh(["python3", "-c", fileOperation]);
  return new Promise<any>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let output = "", error = "";
    const timeout = setTimeout(() => { child.kill(); reject(Error("File operation timed out")); }, 30000);
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { error += chunk; });
    child.on("error", (reason) => { clearTimeout(timeout); reject(reason); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) return reject(Error(error.trim().split("\n").pop() || "File operation failed"));
      try { resolve(JSON.parse(output)); } catch { reject(Error("Invalid file response")); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ ...request, roots: ALLOWED_ROOTS }));
  });
}
export function browseScripts(requested = "") {
  return remoteFileOperation({ path: requested, action: "browse", scripts: true });
}
export function browseFiles(requested = "") {
  return remoteFileOperation({ path: requested, action: "browse", scripts: false });
}
export async function deleteFolder(requested: string) {
  await remoteFileOperation({ path: requested, action: "delete" });
  audit("deleted folder " + requested);
}
export async function changeFile(
  action: "delete" | "copy" | "move" | "rename",
  source: string,
  destination = "",
  name = "",
) {
  const result = await remoteFileOperation({
    path: source,
    action,
    source,
    destination,
    name,
  });
  audit(`${action} ${source}${result.path ? " -> " + result.path : ""}`);
  return result;
}
export function addScript(input: Record<string, string>) {
  const name = (input.name || "").trim().slice(0, 80),
    requested = input.path || "",
    folder = (input.folder || "").trim().replace(/\s+/g, " ").slice(0, 60),
    expr = "";
  if (!name) throw Error("Enter a name");
  if (/[\r\n]/.test(folder)) throw Error("The folder name must be one line");
  let runOptions: RunOption[] = [];
  try {
    const parsed = JSON.parse(input.runOptions || "[]");
    if (!Array.isArray(parsed) || parsed.length > 12) throw Error();
    runOptions = parsed.map((item) => {
      const label = String(item.label || "").trim().slice(0, 80);
      const value = String(item.value || "").trim().slice(0, 500);
      const description = String(item.description || "").trim().slice(0, 180);
      const needsFile = item.needsFile === true;
      if (!label || !value || /[\r\n]/.test(label + value + description)) throw Error();
      return { label, value, description, needsFile };
    });
  } catch {
    throw Error("Each run option needs a name and an argument value");
  }
  if (folder && !folders().includes(folder)) throw Error("Choose an existing folder");
  const resolved = run(["realpath", "-e", requested]).trim();
  if (
    !isAllowedPath(resolved) ||
    !resolved.endsWith(".sh")
  )
    throw Error(
      "The script must be an existing .sh file inside an allowed location",
    );
  run(["test", "-f", resolved]);
  const id = /^[a-f0-9-]{32,36}$/.test(input.id || "")
    ? input.id
    : randomUUID();
  const all = scripts().filter((x) => x.id !== id);
  all.push({ id, name, path: resolved, cron: expr, folder, runOptions });
  save("scripts", all);
}
export function createCustomScript(input: Record<string, string>) {
  const directory = resolveAllowedDirectory(input.directory || "");
  const filename = (input.filename || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.sh$/.test(filename))
    throw Error("Use a shell-script filename ending in .sh");
  const target = path.posix.join(directory, filename);
  if (!isAllowedPath(target)) throw Error("Choose an allowed script folder");
  try {
    run(["test", "!", "-e", target]);
  } catch {
    throw Error("A file or folder with this name already exists");
  }
  const content = input.content || "";
  if (!content.trim() || content.includes("\0") || Buffer.byteLength(content, "utf8") > 128 * 1024)
    throw Error("Enter a shell script up to 128 KB");
  const program = content.startsWith("#!")
    ? content
    : "#!/usr/bin/env bash\nset -eu\n\n" + content;
  runInput(
    ["sh", "-c", 'umask 077; cat > "$1"; chmod 700 "$1"', "sh", target],
    program,
    15000,
  );
  try {
    addScript({ ...input, path: target });
  } catch (error) {
    run(["rm", "-f", "--", target]);
    throw error;
  }
  audit("created custom script " + target);
}
