import { NextResponse } from "next/server";
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
  CONTAINER_NAME,
  containerLogs,
  containerSize,
  cronRuns,
  createCustomScript,
  createFileOrFolder,
  deleteDashboardFolder,
  evaluateAlerts,
  exportConfiguration,
  failingCronRuns,
  folderSizes,
  folders,
  historyPage,
  hostSnapshot,
  HISTORY_RANGES,
  type HistoryRange,
  metricHistory,
  metricsSummary,
  monitoredPaths,
  preflight,
  publicRun,
  readEditableFile,
  readRunLogEnd,
  recentRuns,
  recordMetricSample,
  removeMonitoredPath,
  renameDashboardFolder,
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
  stopRun,
  syncCron,
  testServerConnection,
  updateServerSettings,
  verifySudoPassword,
  notificationLanguage,
} from "@/lib/server";
import { DRIVERS, deletePowerDevice, powerHistory, publicDevices, savePowerDevice, savePowerSettings, powerSettings, switchPowerDevice } from "@/lib/power";
import { CHANNEL_TYPES, deleteChannel, publicChannels, saveChannel, testChannel } from "@/lib/notify";
import { EVENT_TYPES } from "@/lib/server";
import { accountRoutes } from "./auth";
import { demoState } from "./demo";
import { type Body, type Context, type Routes, ok } from "./http";
import { isLanguage, t } from "@/lib/server";

// Dashboard records stored in DATA_DIR; reading them needs no SSH.
function records({ devices, user, session }: Context) {
  return {
    user,
    scripts: scripts(),
    folders: folders(),
    schedules: schedules(),
    devices,
    // The browser making the request, so the page can tell it from the others.
    device: session.device,
    host: serverSettings().sshTarget || "local server",
    recentRuns: recentRuns(),
    alerts: alertRules(),
    metrics: metricsSummary(),
    monitoredPaths: monitoredPaths(),
  };
}

// ?scope=records returns only the stored records, for pages that show no live
// host data; the background monitor keeps metrics and alerts current meanwhile.
// The default reads the host as well. Neither carries the run history, only the
// recent runs and the scheduled runs that are still failing; History asks for
// its pages.
async function state(context: Context) {
  const { req, session } = context;
  if (session.device === "demo") return NextResponse.json({ ...demoState, user: context.user });
  const scope = req.nextUrl.searchParams.get("scope");
  if (scope === "records") return NextResponse.json({ ...records(context), cronFailures: cronFailures(cronRuns()) });
  let snapshot;
  try {
    snapshot = await hostSnapshot();
  } catch {
    return NextResponse.json({ error: t("Server unavailable. Check the SSH connection in Settings and reconnect."), code: "HOST_UNAVAILABLE" }, { status: 503 });
  }
  recordMetricSample(snapshot.stats);
  const alerts = evaluateAlerts(snapshot);
  const { cronLog, ...host } = snapshot;
  return NextResponse.json({
    ...host,
    ...records(context),
    alertState: alerts,
    cronFailures: cronFailures(await collectCronRuns(cronLog)),
  });
}
// A handful is plenty for Overview; History lists every run.
const cronFailures = (runs: ReturnType<typeof cronRuns>) => failingCronRuns(runs, schedules()).slice(0, 5);

// One page of script runs or, with ?kind=cron, of scheduled runs, with the
// number of each for the page's tabs. The scheduled runs are read from the
// server first, so the page is current without a full refresh.
async function history({ req, session }: Context) {
  const query = req.nextUrl.searchParams;
  const page = { search: query.get("search") || "", status: query.get("status") || "", offset: Number(query.get("offset")), limit: Number(query.get("limit")) };
  if (session.device === "demo") return NextResponse.json({ ...historyPage([], () => "", page), counts: { scripts: 0, cron: 0 } });
  const cron = query.get("kind") === "cron";
  const scheduled = cron ? await collectCronRuns() : cronRuns();
  const manual = scriptRuns();
  // A scheduled run is named after what it runs, the script or the command.
  const names = new Map(schedules().map((item) => [item.id, scripts().find((script) => script.id === item.scriptId)?.name || item.command || ""]));
  const named = scheduled.map((run) => ({ ...run, name: names.get(run.scheduleId) || run.label }));
  const result = cron
    ? historyPage(named, (run) => `${run.name} ${run.label}`, page)
    : historyPage(manual.map(publicRun), (run) => run.scriptName, page);
  return NextResponse.json({ ...result, counts: { scripts: manual.length, cron: scheduled.length } });
}

function findScript(body: Body) {
  const script = scripts().find((item) => item.id === body.id);
  if (!script) throw Error(t("Script not found"));
  return script;
}

async function changeSchedule(body: Body, change: "delete" | "toggle") {
  let all = schedules();
  const current = all.find((item) => item.id === body.id);
  if (!current) throw Error(t("Schedule not found"));
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
        ...(body.sshPort ? { sshPort: Number(body.sshPort) } : {}),
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
  "GET preflight": async () => NextResponse.json(await preflight()),
  "POST container": async ({ body }) => {
    if (
      !["start", "stop", "restart", "logs"].includes(body.action) ||
      !CONTAINER_NAME.test(body.name || "")
    )
      throw Error(t("Invalid action"));
    const output =
      body.action === "logs"
        ? await containerLogs(body.name)
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

// Sessions that showed hidden files with the sudo password, until when. The
// sudo password is checked on the server and never kept.
const HIDDEN_SHOWN_MS = 15 * 60 * 1000;
const hiddenShown = new Map<string, number>();
const sudoFailures = new Map<string, { count: number; since: number }>();
const SUDO_ATTEMPTS = 5, SUDO_WINDOW_MS = 15 * 60 * 1000;
// Whether this request may see hidden files: it asks to, and its session showed them.
function showsHidden({ body, sid }: Context) {
  const until = hiddenShown.get(sid) ?? 0;
  if (until && until < Date.now()) hiddenShown.delete(sid);
  return String(body.hidden) === "true" && until > Date.now();
}
const fileRoutes: Routes<Context> = {
  "POST file/hidden": async ({ body, sid, user }) => {
    if (String(body.show) !== "true") {
      hiddenShown.delete(sid);
      return ok({ shown: false });
    }
    const now = Date.now(), failures = sudoFailures.get(user.name);
    if (failures && now - failures.since > SUDO_WINDOW_MS) sudoFailures.delete(user.name);
    else if (failures && failures.count >= SUDO_ATTEMPTS)
      throw Error(t("Too many wrong sudo passwords. Try again in {minutes} minute(s).", { minutes: Math.ceil((failures.since + SUDO_WINDOW_MS - now) / 60000) }));
    try {
      await verifySudoPassword(String(body.password || ""));
    } catch (error) {
      const previous = sudoFailures.get(user.name);
      sudoFailures.set(user.name, previous ? { ...previous, count: previous.count + 1 } : { count: 1, since: now });
      audit("hidden files: wrong sudo password");
      throw error;
    }
    sudoFailures.delete(user.name);
    hiddenShown.set(sid, now + HIDDEN_SHOWN_MS);
    audit("hidden files shown for 15 minutes");
    return ok({ shown: true, until: now + HIDDEN_SHOWN_MS });
  },
  "POST file/browse": async (context) => {
    const { body } = context, hidden = showsHidden(context);
    return NextResponse.json({
      ...await browseFiles(body.path || "", {
        search: body.search || "", sort: body.sort || "name",
        offset: Number(body.offset || 0), limit: Number(body.limit || 100), hidden,
      }),
      // A session whose time ran out asked for hidden files without getting them.
      hidden, hiddenRequested: String(body.hidden) === "true",
    });
  },
  "POST file/sizes": async (context) => NextResponse.json(await folderSizes(context.body.path || "", showsHidden(context))),
  "POST file/operation": async (context) => {
    const { body } = context;
    const action = body.action;
    if (!["delete", "copy", "move", "rename"].includes(action))
      throw Error(t("Invalid file operation"));
    return NextResponse.json(
      await changeFile(
        action as "delete" | "copy" | "move" | "rename",
        body.source || "",
        body.destination || "",
        body.name || "",
        showsHidden(context),
      ),
    );
  },
  "POST file/create": async (context) => {
    const { body } = context, kind = body.kind === "folder" ? "folder" : "file";
    return NextResponse.json(await createFileOrFolder(body.path || "", body.name || "", kind, showsHidden(context)));
  },
  "POST file/read": async (context) => NextResponse.json(await readEditableFile(context.body.path || "", showsHidden(context))),
  "POST file/save": async (context) => {
    const { body } = context;
    await saveEditableFile(body.path || "", body.content || "", showsHidden(context));
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
      throw Error(t("Choose a valid run option"));
    const selected = script.runOptions[option];
    if (selected.needsFile && !body.file)
      throw Error(t("Choose a file before running this option"));
    const value = selected.input ? String(body.value ?? "").trim() : "";
    if (selected.input && !value) throw Error(t("Enter “{field}” before running this option", { field: selected.input }));
    return ok({ run: await runScript(script, selected.value, selected.needsFile ? body.file : "", value) });
  },
  // The end of a run's log (the script's latest run without runId) and the
  // run itself, so the log viewer can show its status and stop it.
  "POST script/log": ({ body }) => {
    const script = findScript(body);
    const runRecord = body.runId
      ? scriptRuns().find((item) => item.id === body.runId && item.scriptId === script.id)
      : scriptRuns().find((item) => item.scriptId === script.id);
    const output = (runRecord?.logPath ? readRunLogEnd(runRecord.logPath) : null) ?? t("No dashboard run log is available yet.");
    return NextResponse.json({ output, run: runRecord ? publicRun(runRecord) : null });
  },
  "POST script/stop": async ({ body, user }) => {
    await stopRun(body.runId || "", user.name);
    return ok();
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
  "POST folder/rename": ({ body }) => {
    renameDashboardFolder(body.name || "", body.newName || "");
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
  "GET history/runs": history,
  "GET history/metrics": ({ req }) => {
    const range = req.nextUrl.searchParams.get("range") || "24h";
    if (!(range in HISTORY_RANGES)) throw Error(t("Choose 24h, 7d or 30d"));
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

const powerRoutes: Routes<Context> = {
  "GET power/drivers": () => NextResponse.json({ drivers: DRIVERS.map(({ id, name, description, fields }) => ({
    id, name, description: t(description),
    fields: fields.map((field) => ({ ...field, label: t(field.label), ...(field.help ? { help: t(field.help) } : {}) })),
  })) }),
  "GET power/devices": () => NextResponse.json({ devices: publicDevices(), settings: powerSettings() }),
  "POST power/device/save": async ({ body }) => ok({ reading: await savePowerDevice(body) }),
  "POST power/device/delete": ({ body }) => {
    deletePowerDevice(body.id || "");
    return ok();
  },
  "POST power/device/switch": async ({ body }) => ok(await switchPowerDevice(body.id || "", String(body.on) === "true")),
  "POST power/settings": ({ body }) => {
    savePowerSettings(body);
    return ok();
  },
  "GET power/history": ({ req }) => {
    const range = req.nextUrl.searchParams.get("range") || "24h";
    if (range !== "24h" && range !== "7d" && range !== "30d") throw Error(t("Choose 24h, 7d or 30d"));
    return NextResponse.json(powerHistory(range));
  },
};

const notificationRoutes: Routes<Context> = {
  "GET notifications": () => NextResponse.json({
    channels: publicChannels(),
    types: CHANNEL_TYPES.map((type) => ({ ...type, name: t(type.name), help: t(type.help) })),
    events: Object.fromEntries(Object.entries(EVENT_TYPES).map(([id, label]) => [id, t(label)])),
    language: notificationLanguage(),
  }),
  "POST notifications/language": ({ body }) => {
    if (!isLanguage(body.language)) throw Error(t("Choose a language"));
    save("notification-settings", { language: body.language });
    audit(`notification language ${body.language}`);
    return ok();
  },
  "POST notifications/save": ({ body }) => {
    saveChannel(body);
    return ok();
  },
  "POST notifications/delete": ({ body }) => {
    deleteChannel(body.id || "");
    return ok();
  },
  "POST notifications/test": async ({ body }) => {
    await testChannel(body.id || "");
    return ok();
  },
};

export const routes: Routes<Context> = {
  ...notificationRoutes,
  ...powerRoutes,
  ...accountRoutes,
  ...hostRoutes,
  ...fileRoutes,
  ...scriptRoutes,
  ...historyRoutes,
};
