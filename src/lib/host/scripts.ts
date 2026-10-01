// Registered scripts: folders, run options, running them and their run logs.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { DATA, audit, emitDashboardEvent, read, save } from "./store";
import { ROOT_SCRIPT_HELPER, run, runInput, ssh } from "./ssh";
import { RECORD_ID, type RunOption, type Script, type ScriptRun, folders, schedules, scriptRuns, scripts } from "./records";
import { rootScriptStatus, syncCron } from "./cron";
import { isAllowedPath, resolveAllowedDirectory, resolveSelectedFile } from "./files";
const MAX_SCRIPT_RUNS = 2000;
// Keeps the newest runs and deletes the logs of the records that are dropped.
function saveScriptRuns(runs: ScriptRun[]) {
  save("script-runs", runs.slice(0, MAX_SCRIPT_RUNS));
  const logs = path.join(DATA, "runs") + path.sep;
  for (const run of runs.slice(MAX_SCRIPT_RUNS))
    if (run.logPath?.startsWith(logs)) rmSync(/* turbopackIgnore: true */ run.logPath, { force: true });
}
// A server restart ends the SSH processes that were streaming running scripts,
// so their records would otherwise stay "running" forever.
export function recoverInterruptedRuns() {
  const runs = scriptRuns();
  if (!runs.some((item) => item.status === "running")) return;
  const now = new Date().toISOString();
  save("script-runs", runs.map((item) => {
    if (item.status !== "running") return item;
    try { appendFileSync(/* turbopackIgnore: true */ item.logPath, "\nThe run was interrupted because the dashboard restarted.\n"); } catch {}
    return { ...item, status: "failed" as const, completedAt: now, durationMs: Date.parse(now) - Date.parse(item.startedAt) };
  }));
}
export function parseRunOptions(value: unknown): RunOption[] {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value || "[]") : value ?? [];
    if (!Array.isArray(parsed) || parsed.length > 12) throw Error();
    return parsed.map((item) => {
      const label = String(item?.label || "").trim().slice(0, 80);
      const value = String(item?.value || "").trim().slice(0, 500);
      const description = String(item?.description || "").trim().slice(0, 180);
      if (!label || !value || /[\r\n\0]/.test(label + value + description)) throw Error();
      return { label, value, description, needsFile: item.needsFile === true };
    });
  } catch {
    throw Error("Each run option needs a name and an argument value");
  }
}
export function addFolder(input: string) {
  const name = input.trim().replace(/\s+/g, " ").slice(0, 60);
  if (!name) throw Error("Enter a folder name");
  if (name === "Unfiled") throw Error("This folder name is reserved");
  if (/[\r\n]/.test(name)) throw Error("The folder name must be one line");
  const all = folders();
  if (!all.includes(name)) save("folders", [...all, name]);
}
export async function deleteDashboardFolder(input: string, deleteScripts = false) {
  const name = input.trim();
  if (!name) throw Error("Choose a dashboard folder");
  const stored = read<string[]>("folders", []);
  const belongsToFolder = (script: Script) =>
    name === "Unfiled" ? !script.folder : script.folder === name;
  if (!stored.includes(name) && !scripts().some(belongsToFolder))
    throw Error("Folder not found");
  const removedScripts = scripts().filter(belongsToFolder);
  if (removedScripts.length && !deleteScripts)
    throw Error("This folder still contains scripts");
  const removedIds = new Set(removedScripts.map((script) => script.id));
  save("folders", stored.filter((folder) => folder !== name));
  if (removedIds.size) {
    save("scripts", scripts().filter((script) => !removedIds.has(script.id)));
    const removedSchedules = schedules().filter((item) => removedIds.has(item.scriptId));
    const remainingSchedules = schedules().filter((item) => !removedIds.has(item.scriptId));
    save("schedules", remainingSchedules);
    await syncCron(removedSchedules.map((item) => item.runAs || "user"));
  }
  audit(`folder deleted ${name} (${removedScripts.length} scripts)`);
  return { deletedScripts: removedScripts.length };
}
export function parseArguments(value: string) {
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
const MAX_RUN_LOG_BYTES = 10 * 1024 * 1024;
export async function runScript(s: Script, rawArguments = "", selectedFile = "") {
  const scriptArguments = parseArguments(rawArguments);
  if (selectedFile) {
    const fileIndex = scriptArguments.indexOf("--file");
    scriptArguments.splice(
      fileIndex >= 0 ? fileIndex + 1 : scriptArguments.length,
      0,
      await resolveSelectedFile(selectedFile),
    );
  }
  if (s.runAs === "root" && !(await rootScriptStatus()).available)
    throw Error("Root script access has not been enabled on this server");
  const command =
      s.runAs === "root"
        ? ["sudo", "-n", ROOT_SCRIPT_HELPER, "run", s.path, ...scriptArguments]
        : ["/bin/bash", s.path, ...scriptArguments],
    runId = randomUUID(),
    log = path.join(DATA, "runs", runId + ".log"),
    [cmd, args] = ssh(command);
  mkdirSync(path.dirname(log), { recursive: true });
  const started = Date.now();
  const record: ScriptRun = {
    id: runId, scriptId: s.id, scriptName: s.name, startedAt: new Date(started).toISOString(),
    arguments: rawArguments, status: "running", logPath: log,
  };
  saveScriptRuns([record, ...scriptRuns()]);
  const out = openSync(log, "a");
  let finished = false, written = 0;
  // Output past the limit is read and dropped, so a noisy script keeps running
  // without filling the data volume.
  const write = (chunk: Buffer | string) => {
    if (finished || written > MAX_RUN_LOG_BYTES) return;
    const data = Buffer.from(chunk);
    writeSync(out, data.subarray(0, MAX_RUN_LOG_BYTES - written));
    written += data.length;
    if (written > MAX_RUN_LOG_BYTES) writeSync(out, "\n[Output truncated: this log reached 10 MB.]\n");
  };
  const finish = (code: number | null) => {
    if (finished) return;
    finished = true;
    closeSync(out);
    const completed = Date.now();
    const all = scriptRuns().map((item) => item.id === runId ? {
      ...item, completedAt: new Date(completed).toISOString(), durationMs: completed - started,
      exitCode: code ?? 1, status: code === 0 ? "success" as const : "failed" as const,
    } : item);
    save("script-runs", all);
    audit(`script ${s.name} ${code === 0 ? "completed" : "failed"} (${runId})`);
    if (code !== 0) emitDashboardEvent({ type: "script-failed", severity: "critical", title: `Script failed: ${s.name}`, message: code === null ? "The run could not be started." : `The run ended with exit code ${code} after ${Math.round((completed - started) / 1000)} s.` });
  };
  try {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", write);
    child.stderr?.on("data", write);
    child.on("error", (error) => {
      appendFileSync(log, `\nThe run could not be started: ${error.message}\n`);
      finish(null);
    });
    child.on("close", finish);
  } catch (error) {
    finish(null);
    throw error;
  }
  audit("run script " + s.name + " (" + runId + ")");
  return record;
}
export async function addScript(input: Record<string, string>) {
  const name = (input.name || "").trim().slice(0, 80),
    requested = input.path || "",
    folder = (input.folder || "").trim().replace(/\s+/g, " ").slice(0, 60),
    expr = "",
    runAs: "user" | "root" = input.runAs === "root" ? "root" : "user";
  if (!name) throw Error("Enter a name");
  if (/[\r\n]/.test(folder)) throw Error("The folder name must be one line");
  const runOptions = parseRunOptions(input.runOptions);
  if (folder && !folders().includes(folder)) throw Error("Choose an existing folder");
  if (runAs === "root" && !(await rootScriptStatus()).available)
    throw Error("Root script access has not been enabled on this server");
  let resolved: string;
  try { resolved = (await run(["realpath", "-e", "--", requested])).trim(); }
  catch { throw Error("The script file was not found"); }
  if (
    !isAllowedPath(resolved) ||
    !resolved.endsWith(".sh")
  )
    throw Error(
      "The script must be an existing .sh file inside an allowed location",
    );
  try { await run(["test", "-f", resolved]); }
  catch { throw Error("The script must be a regular file"); }
  const id = RECORD_ID.test(input.id || "") ? input.id : randomUUID();
  const all = scripts().filter((x) => x.id !== id);
  all.push({ id, name, path: resolved, cron: expr, folder, runAs, runOptions });
  save("scripts", all);
}
export async function createCustomScript(input: Record<string, string>) {
  const directory = await resolveAllowedDirectory(input.directory || "");
  const filename = (input.filename || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.sh$/.test(filename))
    throw Error("Use a shell-script filename ending in .sh");
  const target = path.posix.join(directory, filename);
  if (!isAllowedPath(target)) throw Error("Choose an allowed script folder");
  try {
    await run(["test", "!", "-e", target]);
  } catch {
    throw Error("A file or folder with this name already exists");
  }
  const content = input.content || "";
  if (!content.trim() || content.includes("\0") || Buffer.byteLength(content, "utf8") > 128 * 1024)
    throw Error("Enter a shell script up to 128 KB");
  const program = content.startsWith("#!")
    ? content
    : "#!/usr/bin/env bash\nset -eu\n\n" + content;
  await runInput(
    ["sh", "-c", 'umask 077; cat > "$1"; chmod 700 "$1"', "sh", target],
    program,
    15000,
  );
  try {
    await addScript({ ...input, path: target });
  } catch (error) {
    await run(["rm", "-f", "--", target]).catch(() => {});
    throw error;
  }
  audit("created custom script " + target);
}
