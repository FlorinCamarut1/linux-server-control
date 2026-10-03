// Export and restore of the dashboard's own configuration.
import { audit, read, save } from "./store";
import { type ServerSettings, serverSettings, validateServerSettings } from "./ssh";
import { type Script, RECORD_ID, alertRules, folders, oneLine, schedules, scripts } from "./records";
import { normalizeSchedule, rootSchedulesAvailable, syncCron } from "./cron";
import { cleanStoragePath, monitoredPaths, normalizeAlert } from "./monitor";
import { parseRunOptions, parseTimeLimit, parseVariables } from "./scripts";
import { t } from "../i18n";
export function exportConfiguration() {
  return { version: 1, exportedAt: new Date().toISOString(), scripts: scripts(), folders: folders(), schedules: schedules(), devices: read("devices", {}), alerts: alertRules(), serverSettings: serverSettings(), monitoredPaths: monitoredPaths() };
}
function folderName(value: unknown) {
  const name = oneLine(value, 60).replace(/\s+/g, " ");
  if (name === "Unfiled") throw Error(t("This folder name is reserved"));
  return name;
}
function restoredScript(input: Record<string, unknown>, roots: string[], knownFolders: string[]): Script {
  if (typeof input.id !== "string" || !RECORD_ID.test(input.id)) throw Error(t("A script has an invalid identifier"));
  const name = oneLine(input.name, 80);
  if (!name) throw Error(t("Every script needs a name"));
  const scriptPath = typeof input.path === "string" ? input.path : "";
  // Restore cannot resolve symlinks on the host, so it accepts only already
  // canonical-looking paths inside the restored allowed locations.
  if (!scriptPath.startsWith("/") || !scriptPath.endsWith(".sh") || /[\r\n\0]/.test(scriptPath) ||
      scriptPath.split("/").some((part) => part === "." || part === "..") ||
      !roots.some((root) => scriptPath.startsWith(root + "/")))
    throw Error(t("Script “{name}” is not a .sh file inside an allowed location", { name }));
  const folder = folderName(input.folder);
  if (folder && !knownFolders.includes(folder)) throw Error(t("Script “{name}” uses an unknown folder", { name }));
  const runAs = input.runAs === "root" ? "root" : "user";
  const variables = parseVariables(input.variables);
  if (runAs === "root" && variables) throw Error(t("Script “{name}” runs as root, which takes arguments only, not variables", { name }));
  return {
    id: input.id, name, path: scriptPath, cron: "", folder, runAs,
    argumentHint: oneLine(input.argumentHint, 200) || undefined,
    runOptions: parseRunOptions(input.runOptions),
    timeLimitMinutes: parseTimeLimit(input.timeLimitMinutes),
    variables,
    singleRun: input.singleRun === true || undefined,
    confirmRun: input.confirmRun === true || undefined,
    notifySuccess: input.notifySuccess === true || undefined,
  };
}
const objects = (value: unknown, label: string) => {
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object"))
    throw Error(t("Invalid configuration backup: {label}", { label }));
  return value as Record<string, unknown>[];
};
// Every record is validated before anything is written, so a rejected backup
// leaves the current configuration untouched.
export async function restoreConfiguration(payload: Record<string, unknown>) {
  if (payload.version !== 1) throw Error(t("Invalid configuration backup"));
  const settings = payload.serverSettings && typeof payload.serverSettings === "object"
    ? validateServerSettings(payload.serverSettings as Partial<ServerSettings>)
    : serverSettings();
  if (!Array.isArray(payload.folders)) throw Error(t("Invalid configuration backup: folders"));
  const restoredFolders = [...new Set(payload.folders.map(folderName).filter(Boolean))];
  const restoredScripts = objects(payload.scripts, "scripts").map((item) => restoredScript(item, settings.allowedPaths, [...restoredFolders]));
  const restoredScheduleInput = objects(payload.schedules, "schedules");
  const rootCronAvailable = restoredScheduleInput.some((item) => item.runAs === "root") && await rootSchedulesAvailable();
  const restoredSchedules = restoredScheduleInput.map((item) => {
    if (typeof item.id !== "string" || !RECORD_ID.test(item.id)) throw Error(t("A schedule has an invalid identifier"));
    return normalizeSchedule(item, restoredScripts, rootCronAvailable);
  });
  const restoredAlerts = objects(payload.alerts, "alerts").map(normalizeAlert);
  let restoredDevices: Record<string, { name: string; created: string }> | undefined;
  if (payload.devices !== undefined) {
    if (!payload.devices || typeof payload.devices !== "object" || Array.isArray(payload.devices)) throw Error(t("Invalid configuration backup: devices"));
    restoredDevices = Object.fromEntries(Object.entries(payload.devices as Record<string, Record<string, unknown>>).map(([id, device]) => {
      if (!/^[a-f0-9]{64}$/.test(id) || !device || typeof device !== "object") throw Error(t("Invalid configuration backup: devices"));
      return [id, { name: oneLine(device.name, 80) || "Browser", created: oneLine(device.created, 40) }];
    }));
  }
  // Absent in older backups, which leave the monitored paths as they are.
  let restoredPaths: string[] | undefined;
  if (payload.monitoredPaths !== undefined) {
    if (!Array.isArray(payload.monitoredPaths)) throw Error(t("Invalid configuration backup: monitored paths"));
    restoredPaths = [...new Set(payload.monitoredPaths.map((item) => {
      const restored = cleanStoragePath(oneLine(item, 4096));
      if (!restored.startsWith("/")) throw Error(t("Invalid configuration backup: monitored paths must be absolute"));
      return restored;
    }))];
  }
  const previousUsers = schedules().map((item) => item.runAs || "user");
  save("server-settings", settings);
  save("folders", restoredFolders);
  save("scripts", restoredScripts);
  save("schedules", restoredSchedules);
  save("alerts", restoredAlerts);
  if (restoredDevices) save("devices", restoredDevices);
  if (restoredPaths) save("monitored-paths", restoredPaths);
  // Include the previous users so schedules removed by the restore also leave their crontab.
  await syncCron(previousUsers);
  audit("configuration restored");
}
