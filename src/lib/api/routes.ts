import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import {
  addFolder,
  addMonitoredPath,
  addScript,
  alertRules,
  audit,
  browseFiles,
  browseScripts,
  changeFile,
  collectCronRuns,
  containerSize,
  cronRuns,
  createCustomScript,
  createFileOrFolder,
  deleteDashboardFolder,
  evaluateAlerts,
  exportConfiguration,
  folderSizes,
  folders,
  hostSnapshot,
  HISTORY_RANGES,
  type HistoryRange,
  metricHistory,
  metricsSummary,
  monitoredPaths,
  readEditableFile,
  recordMetricSample,
  removeMonitoredPath,
  restoreConfiguration,
  run,
  runScript,
  save,
  saveAlert,
  saveEditableFile,
  saveSchedule,
  schedules,
  scriptRuns,
  scripts,
  serverSettings,
  syncCron,
  testServerConnection,
  updateServerSettings,
} from "@/lib/server";
import { accountRoutes } from "./auth";
import { demoState } from "./demo";
import { type Body, type Context, type Routes, ok } from "./http";

// Dashboard records stored in DATA_DIR; reading them needs no SSH.
function records(devices: Context["devices"]) {
  return {
    scripts: scripts(),
    folders: folders(),
    schedules: schedules(),
    devices,
    host: serverSettings().sshTarget || "local server",
    runs: scriptRuns(),
    alerts: alertRules(),
    metrics: metricsSummary(),
    monitoredPaths: monitoredPaths(),
  };
}

// ?scope=records returns only the stored records, for pages that show no live
// host data; the background monitor keeps metrics and alerts current meanwhile.
// ?scope=history adds the cron runs. The default reads the host as well.
async function state({ req, session, devices }: Context) {
  if (session.device === "demo") return NextResponse.json(demoState);
  const scope = req.nextUrl.searchParams.get("scope");
  if (scope === "records") return NextResponse.json({ ...records(devices), cronRuns: cronRuns() });
  if (scope === "history") return NextResponse.json({ ...records(devices), cronRuns: await collectCronRuns() });
  let snapshot;
  try {
    snapshot = await hostSnapshot();
  } catch {
    return NextResponse.json({ error: "Server unavailable. Check the SSH connection in Settings and reconnect.", code: "HOST_UNAVAILABLE" }, { status: 503 });
  }
  recordMetricSample(snapshot.stats);
  const alerts = evaluateAlerts(snapshot);
  const { cronLog, ...host } = snapshot;
  return NextResponse.json({
    ...host,
    ...records(devices),
    alertState: alerts,
    cronRuns: await collectCronRuns(cronLog),
  });
}

function findScript(body: Body) {
  const script = scripts().find((item) => item.id === body.id);
  if (!script) throw Error("Script not found");
  return script;
}

async function changeSchedule(body: Body, change: "delete" | "toggle") {
  let all = schedules();
  const current = all.find((item) => item.id === body.id);
  if (!current) throw Error("Schedule not found");
  all =
    change === "delete"
      ? all.filter((item) => item.id !== body.id)
      : all.map((item) =>
          item.id === body.id ? { ...item, enabled: !item.enabled } : item,
        );
  save("schedules", all);
  await syncCron([current.runAs || "user"]);
  audit(`schedule/${change} ${body.id}`);
  return ok();
}

const hostRoutes: Routes<Context> = {
  "GET state": state,
  "GET settings/server": () => NextResponse.json(serverSettings()),
  "POST settings/server": async ({ body }) => {
    const previous = serverSettings();
    try {
      const settings = updateServerSettings({
        sshTarget: body.sshTarget,
        scriptRoot: body.scriptRoot,
        allowedPaths: (body.allowedPaths || "").split(",").filter(Boolean),
        remoteLogs: body.remoteLogs,
        metricsRetentionDays: Number(body.metricsRetentionDays),
      });
      const connection = await testServerConnection();
      audit("server settings updated");
      return NextResponse.json({ settings, connection });
    } catch (error) {
      updateServerSettings(previous);
      throw error;
    }
  },
  "POST container": async ({ body }) => {
    if (
      !["start", "stop", "restart", "logs"].includes(body.action) ||
      !/^[\w.-]+$/.test(body.name)
    )
      throw Error("Invalid action");
    const output =
      body.action === "logs"
        ? await run(["docker", "logs", "--tail", "300", "--timestamps", body.name])
        : await run(["docker", body.action, body.name], 45000);
    return NextResponse.json({ output });
  },
  "POST container/size": async ({ body }) =>
    NextResponse.json({ size: await containerSize(body.name || "") }),
  "POST storage/add": async ({ body }) =>
    NextResponse.json({ path: await addMonitoredPath(body.path || "") }),
  "POST storage/remove": ({ body }) => {
    removeMonitoredPath(body.path || "");
    return ok();
  },
};

const fileRoutes: Routes<Context> = {
  "POST file/browse": async ({ body }) =>
    NextResponse.json(await browseFiles(body.path || "", {
      search: body.search || "", sort: body.sort || "name",
      offset: Number(body.offset || 0), limit: Number(body.limit || 100),
    })),
  "POST file/sizes": async ({ body }) => NextResponse.json(await folderSizes(body.path || "")),
  "POST file/operation": async ({ body }) => {
    const action = body.action;
    if (!["delete", "copy", "move", "rename"].includes(action))
      throw Error("Invalid file operation");
    return NextResponse.json(
      await changeFile(
        action as "delete" | "copy" | "move" | "rename",
        body.source || "",
        body.destination || "",
        body.name || "",
      ),
    );
  },
  "POST file/create": async ({ body }) => {
    const kind = body.kind === "folder" ? "folder" : "file";
    return NextResponse.json(await createFileOrFolder(body.path || "", body.name || "", kind));
  },
  "POST file/read": async ({ body }) => NextResponse.json(await readEditableFile(body.path || "")),
  "POST file/save": async ({ body }) => {
    await saveEditableFile(body.path || "", body.content || "");
    return ok();
  },
};

const scriptRoutes: Routes<Context> = {
  "POST script/browse": async ({ body }) => NextResponse.json(await browseScripts(body.path || "")),
  "POST script/save": async ({ body }) => {
    await addScript(body);
    return ok();
  },
  "POST script/create-custom": async ({ body }) => {
    await createCustomScript(body);
    return ok();
  },
  "POST script/run": async ({ body }) => {
    const script = findScript(body);
    if (!script.runOptions?.length) return ok({ run: await runScript(script) });
    const option = Number(body.option);
    if (!Number.isInteger(option) || option < 0 || option >= script.runOptions.length)
      throw Error("Choose a valid run option");
    const selected = script.runOptions[option];
    if (selected.needsFile && !body.file)
      throw Error("Choose a file before running this option");
    return ok({ run: await runScript(script, selected.value, selected.needsFile ? body.file : "") });
  },
  "POST script/log": ({ body }) => {
    const script = findScript(body);
    const runRecord = body.runId
      ? scriptRuns().find((item) => item.id === body.runId && item.scriptId === script.id)
      : scriptRuns().find((item) => item.scriptId === script.id);
    const logPath = runRecord?.logPath;
    const output = logPath && existsSync(/* turbopackIgnore: true */ logPath)
      ? readFileSync(/* turbopackIgnore: true */ logPath, "utf8").slice(-64000)
      : "No dashboard run log is available yet.";
    return NextResponse.json({ output });
  },
  "POST script/delete": async ({ body }) => {
    const script = findScript(body);
    save("scripts", scripts().filter((item) => item.id !== script.id));
    const removedSchedules = schedules().filter((item) => item.scriptId === script.id);
    save("schedules", schedules().filter((item) => item.scriptId !== script.id));
    await syncCron(removedSchedules.map((item) => item.runAs || "user"));
    audit(`script deleted ${script.name} (${script.id})`);
    return ok();
  },
  "POST folder/create": ({ body }) => {
    addFolder(body.name || "");
    audit("folder created " + (body.name || "").trim());
    return ok();
  },
  "POST folder/delete": async ({ body }) =>
    ok(await deleteDashboardFolder(body.name || "", body.deleteScripts === "true")),
  "POST schedule/save": async ({ body }) => {
    await saveSchedule(body);
    return ok();
  },
  "POST schedule/delete": ({ body }) => changeSchedule(body, "delete"),
  "POST schedule/toggle": ({ body }) => changeSchedule(body, "toggle"),
};

const historyRoutes: Routes<Context> = {
  "GET history/runs": () => NextResponse.json({ runs: scriptRuns() }),
  "GET history/metrics": ({ req }) => {
    const range = req.nextUrl.searchParams.get("range") || "24h";
    if (!(range in HISTORY_RANGES)) throw Error("Choose 24h, 7d or 30d");
    return NextResponse.json(metricHistory(range as HistoryRange));
  },
  "POST alerts/save": ({ body }) => {
    saveAlert(body);
    return ok();
  },
  "POST alerts/delete": ({ body }) => {
    save("alerts", alertRules().filter((item) => item.id !== body.id));
    audit("alert deleted " + body.id);
    return ok();
  },
  "GET config/export": () => NextResponse.json(exportConfiguration()),
  "POST config/restore": async ({ body }) => {
    await restoreConfiguration(body.payload ? JSON.parse(body.payload) : body);
    return ok();
  },
};

export const routes: Routes<Context> = {
  ...accountRoutes,
  ...hostRoutes,
  ...fileRoutes,
  ...scriptRoutes,
  ...historyRoutes,
};
