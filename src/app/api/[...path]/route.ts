import { NextRequest, NextResponse } from "next/server";
import {
  addScript,
  addFolder,
  audit,
  browseScripts,
  browseFiles,
  changeFile,
  createFileOrFolder,
  collectCronRuns,
  addMonitoredPath,
  removeMonitoredPath,
  monitoredPaths,
  createCustomScript,
  digest,
  folders,
  hash,
  read,
  readEditableFile,
  run,
  runScript,
  rootCronStatus,
  save,
  saveEditableFile,
  schedules,
  scripts,
  secureEqual,
  sessions,
  syncCron,
  hostSnapshot,
  folderSizes,
  token,
  validCron,
  DATA,
  alertRules,
  evaluateAlerts,
  exportConfiguration,
  metricSamples,
  persistSessions,
  recordMetricSample,
  restoreConfiguration,
  scriptRuns,
} from "@/lib/server";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function fail(error: string, status = 400, headers?: HeadersInit) {
  return NextResponse.json({ error }, { status, headers });
}
type LoginAttempt = { failures: number; firstFailure: number; blockedUntil: number };
const loginAttempts = new Map<string, LoginAttempt>();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
function loginKey(req: NextRequest) {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}
function blockedFor(key: string) {
  const attempt = loginAttempts.get(key);
  if (!attempt) return 0;
  const now = Date.now();
  if (attempt.blockedUntil > now)
    return Math.ceil((attempt.blockedUntil - now) / 1000);
  if (now - attempt.firstFailure > LOGIN_WINDOW_MS) loginAttempts.delete(key);
  return 0;
}
function recordLoginFailure(key: string) {
  const now = Date.now();
  const previous = loginAttempts.get(key);
  const attempt =
    !previous || now - previous.firstFailure > LOGIN_WINDOW_MS
      ? { failures: 1, firstFailure: now, blockedUntil: 0 }
      : { ...previous, failures: previous.failures + 1 };
  if (attempt.failures >= LOGIN_MAX_FAILURES)
    attempt.blockedUntil = now + LOGIN_BLOCK_MS;
  loginAttempts.set(key, attempt);
  return attempt.blockedUntil > now;
}
function allowed(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const forwardedProto = req.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  const forwardedHost = req.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim();
  const publicOrigin = `${forwardedProto || req.nextUrl.protocol.replace(":", "")}://${forwardedHost || req.headers.get("host")}`;
  return origin === publicOrigin;
}
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  return handle(req, (await params).path.join("/"), undefined);
}
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  if (!allowed(req)) return fail("Invalid request origin", 403);
  let body;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  return handle(req, (await params).path.join("/"), body);
}
async function handle(
  req: NextRequest,
  route: string,
  body?: Record<string, string>,
) {
  try {
    if (route === "login" && body) {
      const attemptKey = loginKey(req);
      const retryAfter = blockedFor(attemptKey);
      if (retryAfter)
        return fail(
          `Too many sign-in attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
          429,
          { "Retry-After": String(retryAfter) },
        );
      if (
        process.env.NODE_ENV === "development" &&
        body.username === "demo" &&
        body.password === "demo"
      ) {
        const session = token();
        sessions.set(session, {
          device: "demo",
          expires: Date.now() + 28800000,
          created: Date.now(),
        });
        persistSessions();
        const res = NextResponse.json({ ok: true });
        res.cookies.set("session", session, {
          httpOnly: true,
          sameSite: "strict",
          path: "/",
        });
        return res;
      }
      const cfg = read<Record<string, string>>("config", {});
      if (
        body.username !== cfg.username ||
        !secureEqual(
          hash(body.password || "", cfg.salt || "00"),
          cfg.password || "",
        )
      )
        return recordLoginFailure(attemptKey)
          ? fail("Too many sign-in attempts. Try again in 15 minutes.", 429, {
              "Retry-After": String(LOGIN_BLOCK_MS / 1000),
            })
          : fail("Incorrect username or password", 401);
      let device = req.cookies.get("device")?.value || "";
      const devices = read<Record<string, { name: string; created: string }>>(
        "devices",
        {},
      );
      if (!devices[digest(device)]) {
        const enroll = read<{ code?: string; expires?: number }>("enroll", {});
        if (
          (enroll.expires || 0) < Date.now() / 1000 ||
          !secureEqual(body.code || "", enroll.code || "invalid")
        )
          return fail(
            "New browser: enter an enrollment code generated in the dashboard.",
            403,
          );
        device = token();
        devices[digest(device)] = {
          name: (body.deviceName || "Browser").slice(0, 80),
          created: new Date().toLocaleString("ro-RO"),
        };
        save("devices", devices);
        save("enroll", {});
      }
      const session = token();
      loginAttempts.delete(attemptKey);
      sessions.set(session, {
        device: digest(device),
        expires: Date.now() + 28800000,
        created: Date.now(),
      });
      persistSessions();
      const res = NextResponse.json({ ok: true });
      res.cookies.set("session", session, {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        maxAge: 28800,
        path: "/",
      });
      res.cookies.set("device", device, {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        maxAge: 31536000,
        path: "/",
      });
      audit("login");
      return res;
    }
    const sid = req.cookies.get("session")?.value || "",
      session = sessions.get(sid),
      devices = read<Record<string, { name: string; created: string }>>(
        "devices",
        {},
      );
    if (
      !session ||
      session.expires < Date.now() ||
      (session.device !== "demo" && !devices[session.device])
    )
      return fail("Sign in to continue", 401);
    if (route === "enrollment/create" && body) {
      const duration = Number(body.minutes || 15);
      if (![5, 15, 30].includes(duration))
        return fail("Choose a valid code duration.");
      const code = randomBytes(12).toString("base64url");
      const expires = Math.floor(Date.now() / 1000) + duration * 60;
      save("enroll", { code, expires });
      audit(`enrollment code created (${duration} minutes)`);
      return NextResponse.json({ code, expires });
    }
    if (route === "state" && !body) {
      if (session.device === "demo")
        return NextResponse.json({
          host: "demo@media-server",
          time: "08.09.2026 14:32 EEST",
          scripts: [
            { id: "backup", name: "Media backup", path: "/home/media/backup.sh", cron: "" },
            { id: "sync", name: "Sync VPN port", path: "/home/media/sync-port.sh", cron: "" },
          ],
          folders: ["Backups", "Networking"],
          schedules: [
            { id: "morning", scriptId: "backup", expression: "0 3 * * *", label: "Every day at 03:00", enabled: true, runAs: "user" },
          ],
          cron: "0 3 * * * /home/media/backup.sh",
          devices: {
            demo: { name: "Personal laptop", created: "08.09.2026, 14:00" },
          },
          root: { available: false, cron: "", system: "" },
          rootScript: { available: false },
          stats: {
            temperatureC: 46.2,
            memoryUsedBytes: 6940667904,
            memoryTotalBytes: 16777216000,
            memoryAvailableBytes: 9835475100,
            diskUsedBytes: 128849018880,
            diskTotalBytes: 499289948160,
            diskUsedPercent: 26,
            storage: [
              {
                path: "/mnt/storage",
                usedBytes: 1649267441664,
                totalBytes: 3999688294400,
                usedPercent: 41,
              },
            ],
            uptimeSeconds: 196560,
            cpuUsagePercent: 18.4,
            cpuCores: 8,
          },
          containers: [
            {
              ID: "a91b2c3d4e5f",
              Names: "jellyfin",
              Image: "lscr.io/linuxserver/jellyfin:latest",
              State: "running",
              Status: "Up 6 hours (healthy)",
              Ports: "0.0.0.0:8096->8096/tcp",
              CreatedAt: "2026-09-08 08:12:04 +0300 EEST",
              Networks: "media",
              Mounts: "/mnt/storage,/config",
              Size: "1.2GB",
            },
            {
              ID: "b82c3d4e5f6a",
              Names: "sonarr",
              Image: "lscr.io/linuxserver/sonarr:latest",
              State: "running",
              Status: "Up 6 hours",
              Ports: "8989/tcp",
              CreatedAt: "2026-09-08 08:12:10 +0300 EEST",
              Networks: "media",
              Mounts: "/mnt/storage,/config",
              Size: "428MB",
            },
            {
              ID: "c73d4e5f6a7b",
              Names: "transmission",
              Image: "lscr.io/linuxserver/transmission:latest",
              State: "exited",
              Status: "Exited (0) 2 hours ago",
              Ports: "",
              CreatedAt: "2026-09-07 18:30:00 +0300 EEST",
              Networks: "media",
              Mounts: "/downloads,/config",
              Size: "312MB",
            },
          ],
        });
      const snapshot = await hostSnapshot();
      const metrics = recordMetricSample(snapshot.stats);
      const alerts = evaluateAlerts(snapshot);
      return NextResponse.json({
        ...snapshot,
        scripts: scripts(),
        folders: folders(),
        schedules: schedules(),
        devices,
        host: process.env.SSH_TARGET,
        runs: scriptRuns(),
        alerts: alertRules(),
        metrics,
        alertState: alerts,
        cronRuns: collectCronRuns(),
        monitoredPaths: monitoredPaths(),
      });
    }
    if (route === "logout") {
      sessions.delete(sid);
      persistSessions();
      return NextResponse.json({ ok: true });
    }
    if (route === "account/password" && body) {
      const config = read<Record<string, string>>("config", {});
      if (
        !secureEqual(
          hash(body.currentPassword || "", config.salt || "00"),
          config.password || "",
        )
      )
        return fail("The current password is incorrect.", 401);
      if ((body.newPassword || "").length < 12)
        return fail("The new password must contain at least 12 characters.");
      if (body.newPassword !== body.confirmPassword)
        return fail("The new passwords do not match.");
      const salt = randomBytes(16).toString("hex");
      save("config", {
        ...config,
        salt,
        password: hash(body.newPassword, salt),
      });
      for (const key of sessions.keys()) if (key !== sid) sessions.delete(key);
      persistSessions();
      audit("password changed");
      return NextResponse.json({ ok: true });
    }
    if (route === "container" && body) {
      if (
        !["start", "stop", "restart", "logs"].includes(body.action) ||
        !/^[\w.-]+$/.test(body.name)
      )
        throw Error("Invalid action");
      const output =
        body.action === "logs"
          ? run(["docker", "logs", "--tail", "300", "--timestamps", body.name])
          : run(["docker", body.action, body.name], 45000);
      return NextResponse.json({ output });
    }
    if (route === "script/browse" && body)
      return NextResponse.json(await browseScripts(body.path || ""));
    if (route === "file/browse" && body)
      return NextResponse.json(await browseFiles(body.path || "", {
        search: body.search || "", sort: body.sort || "name",
        offset: Number(body.offset || 0), limit: Number(body.limit || 100),
      }));
    if (route === "file/sizes" && body)
      return NextResponse.json(await folderSizes(body.path || ""));
    if (route === "file/operation" && body) {
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
    }
    if (route === "file/create" && body) {
      const kind = body.kind === "folder" ? "folder" : "file";
      return NextResponse.json(await createFileOrFolder(body.path || "", body.name || "", kind));
    }
    if (route === "storage/add" && body)
      return NextResponse.json({ path: addMonitoredPath(body.path || "") });
    if (route === "storage/remove" && body) {
      removeMonitoredPath(body.path || ""); return NextResponse.json({ ok: true });
    }
    if (route === "file/read" && body)
      return NextResponse.json(readEditableFile(body.path || ""));
    if (route === "file/save" && body) {
      saveEditableFile(body.path || "", body.content || "");
      return NextResponse.json({ ok: true });
    }
    if (route === "script/save" && body) {
      addScript(body);
      return NextResponse.json({ ok: true });
    }
    if (route === "script/create-custom" && body) {
      createCustomScript(body);
      return NextResponse.json({ ok: true });
    }
    if (route === "folder/create" && body) {
      addFolder(body.name || "");
      audit("folder created " + (body.name || "").trim());
      return NextResponse.json({ ok: true });
    }
    if (route === "schedule/save" && body) {
      const script = scripts().find((item) => item.id === body.scriptId);
      const command = (body.command || "").trim();
      if (!script && !command) throw Error("Select an existing script");
      if (command.length > 2000 || /[\r\n]/.test(command))
        throw Error("The command must be one line shorter than 2,000 characters");
      const expression = (body.expression || "").trim();
      validCron(expression);
      const runAs: "user" | "root" =
        body.runAs === "root" ? "root" : "user";
      if (runAs === "root" && !rootCronStatus().available)
        throw Error("Root cron access has not been enabled on this server");
      if (runAs === "root" && command)
        throw Error("Root schedules must use an approved script; custom root commands are disabled");
      const item = {
        id: /^[a-f0-9-]{32,36}$/.test(body.id || "")
          ? body.id
          : randomBytes(16).toString("hex"),
        scriptId: script?.id || body.scriptId || "",
        expression,
        label: (body.label || "Schedule").trim().slice(0, 80),
        enabled: body.enabled !== "false",
        runAs,
        ...(command ? { command } : {}),
      };
      const previous = schedules().find((schedule) => schedule.id === item.id);
      const all = schedules().filter((schedule) => schedule.id !== item.id);
      all.push(item);
      save("schedules", all);
      syncCron(all, [previous?.runAs || "user"]);
      audit("schedule saved " + item.id);
      return NextResponse.json({ ok: true });
    }
    if ((route === "schedule/delete" || route === "schedule/toggle") && body) {
      let all = schedules();
      const current = all.find((item) => item.id === body.id);
      if (!current) throw Error("Schedule not found");
      all =
        route === "schedule/delete"
          ? all.filter((item) => item.id !== body.id)
          : all.map((item) =>
              item.id === body.id ? { ...item, enabled: !item.enabled } : item,
            );
      save("schedules", all);
      syncCron(all, [current.runAs || "user"]);
      audit(route + " " + body.id);
      return NextResponse.json({ ok: true });
    }
    if (route.startsWith("script/") && body) {
      const s = scripts().find((x) => x.id === body.id);
      if (!s) throw Error("Script not found");
      if (route === "script/run") {
        if (s.runOptions?.length) {
          const option = Number(body.option);
          if (!Number.isInteger(option) || option < 0 || option >= s.runOptions.length)
            throw Error("Choose a valid run option");
          const selected = s.runOptions[option];
          if (selected.needsFile && !body.file)
            throw Error("Choose a file before running this option");
          return NextResponse.json({ ok: true, run: runScript(s, selected.value, selected.needsFile ? body.file : "") });
        } else return NextResponse.json({ ok: true, run: runScript(s) });
      }
      if (route === "script/log") {
        const runRecord = body.runId ? scriptRuns().find((item) => item.id === body.runId && item.scriptId === s.id) : undefined;
        const p = runRecord?.logPath || path.join(DATA, s.id + ".log");
        let output = existsSync(/* turbopackIgnore: true */ p)
          ? readFileSync(/* turbopackIgnore: true */ p, "utf8").slice(-64000)
          : "No logs available.";
        try {
          output +=
            "\n--- Cron ---\n" +
            run([
              "tail",
              "-c",
              "64000",
              process.env.REMOTE_LOGS + "/" + s.id + ".log",
            ]);
        } catch {}
        return NextResponse.json({ output });
      }
      if (route === "script/delete") {
        const all = scripts().filter((x) => x.id !== s.id);
        save("scripts", all);
        const removedSchedules = schedules().filter(
          (item) => item.scriptId === s.id,
        );
        const remainingSchedules = schedules().filter(
          (item) => item.scriptId !== s.id,
        );
        save("schedules", remainingSchedules);
        syncCron(
          remainingSchedules,
          removedSchedules.map((item) => item.runAs || "user"),
        );
        return NextResponse.json({ ok: true });
      }
    }
    if (route === "history/runs" && !body)
      return NextResponse.json({ runs: scriptRuns() });
    if (route === "history/metrics" && !body)
      return NextResponse.json({ metrics: metricSamples() });
    if (route === "alerts/save" && body) {
      const metric = body.metric as ReturnType<typeof alertRules>[number]["metric"];
      if (!['temperature','cpu','ram','disk','failedScripts','stoppedContainers'].includes(metric)) throw Error("Invalid alert metric");
      const threshold = Number(body.threshold), cooldownMinutes = Number(body.cooldownMinutes);
      if (!Number.isFinite(threshold) || threshold < 0 || !Number.isFinite(cooldownMinutes) || cooldownMinutes < 1 || cooldownMinutes > 10080) throw Error("Invalid alert values");
      const id = /^[a-f0-9-]{32,36}$/.test(body.id || "") ? body.id : randomBytes(16).toString("hex");
      const all = alertRules().filter((item) => item.id !== id);
      all.push({ id, name: (body.name || "Alert").trim().slice(0, 80), metric, threshold, cooldownMinutes, enabled: body.enabled !== "false" });
      save("alerts", all); audit("alert saved " + id); return NextResponse.json({ ok: true });
    }
    if (route === "alerts/delete" && body) {
      save("alerts", alertRules().filter((item) => item.id !== body.id)); audit("alert deleted " + body.id); return NextResponse.json({ ok: true });
    }
    if (route === "config/export" && !body) return NextResponse.json(exportConfiguration());
    if (route === "config/restore" && body) { restoreConfiguration(body.payload ? JSON.parse(body.payload) : body); return NextResponse.json({ ok: true }); }
    if (route === "device/revoke" && body) {
      delete devices[body.id];
      save("devices", devices);
      return NextResponse.json({ ok: true });
    }
    return fail("Not found", 404);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Internal error");
  }
}
