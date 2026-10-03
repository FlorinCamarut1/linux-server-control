"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "@/lib/client-api";
import { Login, ConnectionUnavailable, Setup } from "@/components/auth";
import { ContainerRow } from "@/components/containers";
import { PowerPage } from "@/components/power";
import { containerLinks } from "@/lib/container-links";
import { FileExplorer } from "@/components/files";
import { Overview, HistoryPanel, AlertForm, describeAlert } from "@/components/monitoring";
import { ScheduleForm } from "@/components/schedules";
import { ScriptForm, CustomScriptForm, RunScriptForm, FolderForm } from "@/components/scripts";
import { AppearancePanel, NotificationsPanel, PasswordForm, DevicePanel, ServerSettings, ConfigurationPanel, StorageManager, UsersPanel } from "@/components/settings";
import { appConfirm, appPrompt, Btn, copyText, Panel, Metric, formatBytes, formatPercent, formatUptime, Modal, DialogHost, LiveLogViewer, AppLoading, LoadingScreen, RowMenu, runStatusLabel } from "@/components/ui";
import { applyTheme, savedTheme } from "@/lib/theme";
import { LANGUAGE_CHANGED, applyLanguage, savedLanguage } from "@/lib/language";
import { locale, msg, t, tn } from "@/lib/i18n";
import type { Run, S, Schedule, St } from "@/lib/types";
import {
  Zap,
  CalendarPlus,
  ChevronDown,
  Clock3,
  Container,
  Copy,
  FileTerminal,
  Folder,
  FolderOpen,
  Gauge,
  HardDrive,
  KeyRound,
  LayoutGrid,
  Loader2,
  LogOut,
  Menu,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Square,
  Thermometer,
  Trash2,
  X,
} from "lucide-react";
const nav = [
  ["overview", LayoutGrid, msg("Overview")],
  ["containers", Container, msg("Containers")],
  ["scripts", FileTerminal, msg("Scripts")],
  ["files", FolderOpen, msg("Files")],
  ["cron", Clock3, msg("Schedules")],
  ["power", Zap, msg("Power")],
  ["history", Clock3, msg("History")],
  ["alerts", Thermometer, msg("Alerts")],
  ["settings", KeyRound, msg("Settings")],
] as const;
// The folder of scripts that have none; shown translated, stored as is.
const UNFILED = "Unfiled";
function stateScope(tab: string) {
  return tab === "overview" || tab === "containers" || tab === "cron" ? "full" : "records";
}
export default function Home() {
  const [state, setState] = useState<St | null>(null),
    [err, setErr] = useState(""),
    [busy, setBusy] = useState(""),
    [tab, setTab] = useState("overview"),
    [containerFilter, setContainerFilter] = useState<
      "all" | "running" | "stopped"
    >("all"),
    [logs, setLogs] = useState<{ title: string; path: string; request: unknown } | null>(null),
    [edit, setEdit] = useState<S | null | undefined>(),
    [customScriptEditor, setCustomScriptEditor] = useState(false),
    [runPrompt, setRunPrompt] = useState<S | null>(null),
    [scheduleEditor, setScheduleEditor] = useState<Schedule | null | undefined>(),
    [folderEditor, setFolderEditor] = useState(false),
    [alertEditor, setAlertEditor] = useState<St["alerts"][number] | null | undefined>(),
    [storageManager, setStorageManager] = useState(false),
    [storagePage, setStoragePage] = useState(0),
    // The script folders left open, so they still are after a visit to another page.
    [openFolders, setOpenFolders] = useState<ReadonlySet<string>>(new Set()),
    [enrollment, setEnrollment] = useState<{
      code: string;
      expires: number;
    } | null>(null),
    [copied, setCopied] = useState<"idle" | "copied" | "manual">("idle"),
    [needsSetup, setNeedsSetup] = useState(false),
    [initializing, setInitializing] = useState(true),
    [pendingRequests, setPendingRequests] = useState(0),
    // Bumped when the language changes, so that every text is drawn again.
    [languageReady, setLanguageReady] = useState(false), [, setLanguageVersion] = useState(0),
    // The last failure was the server not answering (the reconnect screen).
    [hostDown, setHostDown] = useState(false),
    // On narrow screens the pages are listed in a menu opened from the top bar.
    [menuOpen, setMenuOpen] = useState(false);
  const accessCode = useRef<HTMLElement>(null);
  const menuToggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const changed = () => setLanguageVersion((version) => version + 1);
    window.addEventListener(LANGUAGE_CHANGED, changed);
    applyLanguage(savedLanguage()).catch(() => {}).finally(() => setLanguageReady(true));
    return () => window.removeEventListener(LANGUAGE_CHANGED, changed);
  }, []);
  useEffect(() => {
    const start = () => setPendingRequests((count) => count + 1);
    const end = () => setPendingRequests((count) => Math.max(0, count - 1));
    window.addEventListener("media-control-request-start", start);
    window.addEventListener("media-control-request-end", end);
    return () => {
      window.removeEventListener("media-control-request-start", start);
      window.removeEventListener("media-control-request-end", end);
    };
  }, []);
  // Pages without live host data refresh only the stored records, which needs
  // no SSH; the first load and the host pages read everything.
  const tabRef = useRef("overview");
  const hostLoaded = useRef(false);
  const refresh = useCallback(async (silent = false) => {
    const scope = hostLoaded.current ? stateScope(tabRef.current) : "full";
    try {
      const data = await api(scope === "full" ? "state" : `state?scope=${scope}`, undefined, silent);
      if (scope === "full") {
        hostLoaded.current = true;
        setState(data);
      } else setState((previous) => (previous ? { ...previous, ...data } : previous));
      setErr("");
      setHostDown(false);
    } catch (e) {
      // Not being signed in is no error on a first visit; it is worth saying
      // only when it ends a session that was open.
      const signedOut = e instanceof ApiError && e.status === 401;
      setErr(signedOut ? (hostLoaded.current ? t("Your session has ended. Sign in again.") : "") : e instanceof Error ? e.message : t("Error"));
      setHostDown(e instanceof ApiError && e.code === "HOST_UNAVAILABLE");
      if (!(e instanceof ApiError) || e.code !== "HOST_UNAVAILABLE") {
        hostLoaded.current = false;
        setState(null);
      }
      try {
        const setup = await api("setup/status", undefined, true);
        setNeedsSetup(!setup.configured);
      } catch {}
    } finally {
      setInitializing(false);
    }
  }, []);
  useEffect(() => {
    let polling = false;
    // Automatic refreshes pause in hidden tabs, but the first load always runs,
    // so a dashboard opened in a background tab is ready when it is shown.
    const poll = async (initial = false) => {
      if ((!initial && document.hidden) || polling) return;
      polling = true;
      try { await refresh(true); } finally { polling = false; }
    };
    void poll(true);
    const scheduled = () => void poll();
    const x = setInterval(scheduled, 15000);
    document.addEventListener("visibilitychange", scheduled);
    return () => {
      clearInterval(x);
      document.removeEventListener("visibilitychange", scheduled);
    };
  }, [refresh]);
  // The saved theme is applied before the first paint by the script in the
  // document head; this also gives the phone's browser bar the theme's color.
  useEffect(() => applyTheme(savedTheme()), []);
  // The open menu takes the focus to the current page, closes on Escape, which
  // gives the focus back to its button, and closes when the screen widens.
  useEffect(() => {
    if (!menuOpen) return;
    document.querySelector<HTMLButtonElement>("nav button.active")?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      menuToggle.current?.focus();
    };
    const wide = window.matchMedia("(min-width: 801px)");
    const widened = () => { if (wide.matches) setMenuOpen(false); };
    document.addEventListener("keydown", key);
    wide.addEventListener("change", widened);
    return () => {
      document.removeEventListener("keydown", key);
      wide.removeEventListener("change", widened);
    };
  }, [menuOpen]);
  const active = useMemo(
    () => state?.containers.filter((c) => c.State === "running").length || 0,
    [state],
  );
  const stopped = (state?.containers.length || 0) - active;
  const storagePerPage = 4;
  const visibleStorage = state?.stats.storage.slice(storagePage * storagePerPage, (storagePage + 1) * storagePerPage) || [];
  const storagePages = Math.max(1, Math.ceil((state?.stats.storage.length || 0) / storagePerPage));
  const visibleContainers = useMemo(() => {
    if (!state || containerFilter === "all") return state?.containers || [];
    return state.containers.filter((container) =>
      containerFilter === "running"
        ? container.State === "running"
        : container.State !== "running",
    );
  }, [containerFilter, state]);
  const scriptFolders = useMemo(() => {
    const groups = new Map<string, S[]>();
    for (const script of state?.scripts || []) {
      const folder = script.folder || UNFILED;
      const scripts = groups.get(folder);
      if (scripts) scripts.push(script);
      else groups.set(folder, [script]);
    }
    return [...groups.entries()].sort(([a], [b]) => {
      if (a === UNFILED) return 1;
      if (b === UNFILED) return -1;
      return a.localeCompare(b);
    });
  }, [state]);
  // Looked up once per refresh instead of once per script row on every render.
  const scriptStatus = useMemo(() => {
    const status = new Map<string, { schedule?: Schedule; lastRun?: Run }>();
    const entry = (id: string) => status.get(id) ?? status.set(id, {}).get(id)!;
    for (const schedule of state?.schedules || []) entry(schedule.scriptId).schedule ??= schedule;
    for (const run of state?.recentRuns || []) entry(run.scriptId).lastRun ??= run;
    return status;
  }, [state]);
  const links = useMemo(() => {
    const hostname = typeof window === "undefined" ? "" : window.location.hostname;
    return new Map((state?.containers || []).map((c) => [c.ID, containerLinks(c, state!.containers, hostname)]));
  }, [state]);
  async function action(key: string, path: string, body: unknown) {
    try {
      setBusy(key);
      await api(path, body);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("Error"));
    } finally {
      setBusy("");
    }
  }
  async function startScript(script: S) {
    try {
      setBusy(script.id);
      const result = await api("script/run", { id: script.id });
      setLogs({
        title: t("{name} logs", { name: script.name }),
        path: "script/log",
        request: { id: script.id, runId: result.run.id },
      });
      await refresh();
    } catch (reason) {
      setErr(reason instanceof Error ? reason.message : t("Could not start script"));
    } finally {
      setBusy("");
    }
  }
  function openLogs(title: string, path: string, body: unknown) {
    setLogs({ title, path, request: body });
  }
  async function signOut() {
    try { await api("logout", {}); } catch {}
    hostLoaded.current = false;
    setErr("");
    setState(null);
  }
  if (initializing || !languageReady) return <LoadingScreen />;
  if (needsSetup)
    return <Setup done={() => { setNeedsSetup(false); void refresh(); }} loading={pendingRequests > 0} />;
  if (!state && hostDown)
    return <ConnectionUnavailable error={err} retry={() => void refresh()} signOut={signOut} loading={pendingRequests > 0} />;
  if (!state)
    return <Login error={err} done={refresh} loading={pendingRequests > 0} />;
  // Read-only accounts see the pages without the controls; the API refuses the rest.
  const readOnly = state.user?.role === "viewer";
  return (
    <div className={`shell${menuOpen ? " menu-open" : ""}`}>
      {pendingRequests > 0 && <AppLoading />}
      <aside>
        <div className="brand">
          <span>
            <img src="/icon.svg" alt="" />
          </span>
          <b>Linux Server Control</b>
          <button
            ref={menuToggle}
            type="button"
            className="menu-toggle"
            aria-label={menuOpen ? t("Close the menu") : t("Open the menu")}
            aria-expanded={menuOpen}
            aria-controls="main-menu"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
        <div id="main-menu" className="menu-panel">
          <nav>
            {nav.filter(([id]) => !readOnly || id !== "files").map(([id, Icon, label]) => (
              <button
                key={id}
                className={tab === id ? "active" : ""}
                aria-current={tab === id ? "page" : undefined}
                onClick={() => {
                  setTab(id);
                  tabRef.current = id;
                  // A page opens at its top; from the menu, the focus returns to its button.
                  window.scrollTo(0, 0);
                  if (menuOpen) {
                    setMenuOpen(false);
                    menuToggle.current?.focus({ preventScroll: true });
                  }
                  void refresh(true);
                }}
              >
                <Icon size={18} />
                {t(label)}
              </button>
            ))}
          </nav>
          <div className="server">
            <i />
            <div>
              <b>{t("Server connected")}</b>
              <small>{state.host}</small>
            </div>
          </div>
        </div>
      </aside>
      {menuOpen && <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />}
      <main>
        <header>
          <div>
            <h1>
              {t(nav.find(([id]) => id === tab)?.[2] ?? "")}
            </h1>
            <p>{t("Updated {time}", { time: state.time })}{state.user ? ` · ${state.user.name}${readOnly ? ` (${t("read-only")})` : ""}` : ""}</p>
          </div>
          <div className="actions">
            <Btn onClick={() => refresh()}>
              <RefreshCw size={16} />
              <span className="button-label">{t("Refresh")}</span>
            </Btn>
            <Btn aria-label={t("Log out")} onClick={signOut}>
              <LogOut size={16} />
            </Btn>
          </div>
        </header>
        {err && (
          <div className="alert">
            {err}
            <button onClick={() => setErr("")}>×</button>
          </div>
        )}
        {state.containerError && (tab === "overview" || tab === "containers") && (
          <div className="alert">{t("Containers cannot be read: {error}", { error: state.containerError })}</div>
        )}
        {tab === "overview" && <Overview state={state} active={active} stopped={stopped} openLogs={openLogs} />}
        {tab === "containers" && (
          <>
            <section className="metrics">
              <Metric
                label={t("Temperature")}
                value={state.stats.temperatureC === null ? t("Unavailable") : `${state.stats.temperatureC.toLocaleString(locale(), { maximumFractionDigits: 1, minimumFractionDigits: 1 })} °C`}
                icon={<Thermometer />}
              />
              <Metric
                label={t("RAM")}
                value={`${formatBytes(state.stats.memoryUsedBytes)} / ${formatBytes(state.stats.memoryTotalBytes)}`}
                note={formatPercent(state.stats.memoryUsedBytes, state.stats.memoryTotalBytes)}
                icon={<Gauge />}
              />
              <Metric
                label={t("System disk")}
                value={t("{size} free", { size: formatBytes(state.stats.diskTotalBytes - state.stats.diskUsedBytes) })}
                note={t("{percent}% used · {size} total", { percent: state.stats.diskUsedPercent, size: formatBytes(state.stats.diskTotalBytes) })}
                icon={<HardDrive />}
              />
              {visibleStorage.map((drive) => (
                <Metric
                  key={drive.path}
                  label={t("Storage ({path})", { path: drive.path })}
                  value={drive.usedPercent === null || drive.usedBytes === null || drive.totalBytes === null
                    ? t("Unavailable")
                    : t("{size} free", { size: formatBytes(drive.totalBytes - drive.usedBytes) })}
                  note={drive.usedBytes === null || drive.totalBytes === null
                    ? t("Check MONITORED_PATHS")
                    : t("{percent}% used · {size} total", { percent: drive.usedPercent ?? 0, size: formatBytes(drive.totalBytes) })}
                  icon={<HardDrive />}
                />
              ))}
              <Metric
                label={t("CPU usage")}
                value={`${state.stats.cpuUsagePercent.toLocaleString(locale(), { maximumFractionDigits: 1, minimumFractionDigits: 1 })}%`}
                note={tn("{count} logical core|{count} logical cores", state.stats.cpuCores)}
                icon={<Gauge />}
              />
              <Metric label={t("Uptime")} value={formatUptime(state.stats.uptimeSeconds)} icon={<Clock3 />} />
              <Metric
                label={t("Containers")}
                value={t("{count} running", { count: active })}
                note={t("{total} total · {stopped} stopped", { total: state.containers.length, stopped })}
                icon={<Container />}
              />
            </section>
            {!readOnly && <div className="actions"><Btn onClick={() => setStorageManager(true)}><HardDrive size={16} />{t("Manage storage paths")}</Btn></div>}
            {state.stats.storage.length > storagePerPage && <div className="actions"><Btn disabled={storagePage === 0} onClick={() => setStoragePage((page) => page - 1)}>{t("Previous storage")}</Btn><small>{t("Storage {page} of {pages}", { page: storagePage + 1, pages: storagePages })}</small><Btn disabled={storagePage + 1 >= storagePages} onClick={() => setStoragePage((page) => page + 1)}>{t("Next storage")}</Btn></div>}
            <Panel
              title={t("All containers")}
              note={t("Live Docker status and controls")}
              extra={
                <div className="container-filters" aria-label={t("Filter containers")}>
                  {([
                    ["all", t("All"), state.containers.length],
                    ["running", t("Running"), active],
                    ["stopped", t("Stopped"), stopped],
                  ] as const).map(([value, label, count]) => (
                    <button
                      key={value}
                      type="button"
                      className={containerFilter === value ? "active" : ""}
                      aria-pressed={containerFilter === value}
                      onClick={() => setContainerFilter(value)}
                    >
                      {label} <span>{count}</span>
                    </button>
                  ))}
                </div>
              }
            >
              {visibleContainers.map((c) => (
                <ContainerRow
                  key={c.ID}
                  c={c}
                  links={links.get(c.ID) || []}
                  busy={busy}
                  act={action}
                  logs={openLogs}
                  readOnly={readOnly}
                />
              ))}
              {!visibleContainers.length && (
                <div className="empty-state">
                  <Container size={22} />
                  <b>{containerFilter === "all" ? t("No containers") : containerFilter === "running" ? t("No running containers") : t("No stopped containers")}</b>
                  <p>
                    {containerFilter === "stopped"
                      ? t("All containers are currently running.")
                      : t("No containers match this filter.")}
                  </p>
                </div>
              )}
            </Panel>
          </>
        )}
        {tab === "scripts" && (
          <Panel
            title={t("Quick actions")}
            note={t("Run and schedule approved scripts")}
            extra={readOnly ? undefined : (
              <div className="actions">
                <Btn onClick={() => setFolderEditor(true)}>
                  <Folder size={16} />
                  {t("New folder")}
                </Btn>
                <Btn className="primary" onClick={() => setEdit(null)}>
                  {t("Add script")}
                </Btn>
                <Btn onClick={() => setCustomScriptEditor(true)}>
                  {t("New custom script")}
                </Btn>
              </div>
            )}
          >
            {scriptFolders.length ? (
              scriptFolders.map(([folder, scripts]) => (
                <details
                  className="script-folder"
                  key={folder}
                  open={openFolders.has(folder)}
                  onToggle={(event) => {
                    const open = event.currentTarget.open;
                    setOpenFolders((current) => {
                      if (current.has(folder) === open) return current;
                      const next = new Set(current);
                      if (open) next.add(folder);
                      else next.delete(folder);
                      return next;
                    });
                  }}
                >
                  <summary>
                    <Folder size={18} />
                    <span>
                      <b>{folder === UNFILED ? t("Unfiled") : folder}</b>
                      <small>{tn("{count} script|{count} scripts", scripts.length)}</small>
                    </span>
                    {!readOnly && <RowMenu
                      label={t("Actions for the folder {name}", { name: folder === UNFILED ? t("Unfiled") : folder })}
                      disabled={!!busy}
                      items={[folder !== UNFILED && {
                        label: t("Edit"), icon: <Pencil size={15} />,
                        onSelect: async () => {
                          const newName = (await appPrompt(t("Folder name:"), folder, t("Edit folder"), t("Save")))?.trim();
                          if (newName && newName !== folder) await action(`folder:${folder}`, "folder/rename", { name: folder, newName });
                        },
                      }, {
                        label: t("Delete folder"), icon: <Trash2 size={15} />, danger: true,
                        onSelect: async () => {
                          const name = folder === UNFILED ? t("Unfiled") : folder;
                          const description = scripts.length
                            ? tn("Delete “{name}”, the script registered in it, and its scheduled jobs? The .sh file will remain on the server.|Delete “{name}”, all {count} scripts registered in it, and their scheduled jobs? The .sh files will remain on the server.", scripts.length, { name })
                            : t("Delete the empty folder “{name}”?", { name });
                          if (await appConfirm(description, t("Delete folder"), t("Delete"), true))
                            await action(`folder:${folder}`, "folder/delete", { name: folder, deleteScripts: String(scripts.length > 0) });
                        },
                      }]}
                    />}
                    <ChevronDown className="chevron" size={18} />
                  </summary>
                  {scripts.map((s) => {
                    const { schedule, lastRun } = scriptStatus.get(s.id) || {};
                    const running = lastRun?.status === "running";
                    return (
                    <div className="script-row" key={s.id}>
                      <div className="service-icon">
                        <FileTerminal size={19} />
                      </div>
                      <div className="grow">
                        <b>{s.name}</b>
                        <small className="path">{s.path}</small>
                        <small>{schedule ? `${schedule.enabled ? t("Scheduled") : t("Schedule paused")}: ${schedule.expression}` : t("Not scheduled")}{" · "}{lastRun ? (running ? t("running since {time}", { time: new Date(lastRun.startedAt).toLocaleTimeString(locale()) }) : t("last run: {status}", { status: runStatusLabel(lastRun.status) })) : t("never run")}{s.timeLimitMinutes ? ` · ${t("time limit {minutes} min", { minutes: s.timeLimitMinutes })}` : ""}</small>
                        {(running || s.runAs === "root") && (
                          <span className="row-badges">
                            {running && <span className="badge root"><Loader2 className="spin" size={12} />{t("Running")}</span>}
                            {s.runAs === "root" && <span className="badge root">root</span>}
                          </span>
                        )}
                      </div>
                      <div className="actions">
                        {!readOnly && <Btn
                          disabled={!!busy}
                          onClick={async () => {
                            if (s.runOptions?.length) return setRunPrompt(s);
                            if (s.confirmRun && !await appConfirm(t("Run “{name}”?", { name: s.name }), t("Run script"), t("Run"), true)) return;
                            await startScript(s);
                          }}
                        >
                          <Play size={15} />
                          {t("Run")}
                        </Btn>}
                        <Btn
                          onClick={() => openLogs(s.name, "script/log", { id: s.id })}
                        >
                          {t("Logs")}
                        </Btn>
                        {!readOnly && <RowMenu
                          label={t("Actions for {name}", { name: s.name })}
                          disabled={!!busy}
                          items={[
                            running && lastRun && {
                              label: t("Stop run"), icon: <Square size={15} />, danger: true,
                              onSelect: async () => {
                                if (await appConfirm(t("Stop the run of “{name}” that started at {time}? The script and every process it started are ended.", { name: s.name, time: new Date(lastRun.startedAt).toLocaleTimeString(locale()) }), t("Stop run"), t("Stop run"), true))
                                  await action(s.id, "script/stop", { runId: lastRun.id });
                              },
                            },
                            { label: t("Schedule"), icon: <CalendarPlus size={15} />, onSelect: () => setScheduleEditor(schedule || { id: "", scriptId: s.id, expression: "0 3 * * *", label: t("Run {name}", { name: s.name }), enabled: true, runAs: s.runAs || "user" }) },
                            { label: t("Edit"), icon: <Pencil size={15} />, onSelect: () => setEdit(s) },
                            {
                              label: t("Delete"), icon: <Trash2 size={15} />, danger: true,
                              onSelect: async () => {
                                if (await appConfirm(t("Delete “{name}” and its scheduled jobs? The .sh file will remain on the server.", { name: s.name }), t("Delete script"), t("Delete"), true))
                                  await action(s.id, "script/delete", { id: s.id });
                              },
                            },
                          ]}
                        />}
                      </div>
                    </div>
                    );
                  })}
                </details>
              ))
            ) : (
              <div className="empty-state">
                <FileTerminal size={22} />
                <b>{t("No scripts yet")}</b>
                <p>{readOnly ? t("An administrator can add scripts.") : t("Add a script to run it or create a schedule.")}</p>
              </div>
            )}
          </Panel>
        )}
        {tab === "files" && <FileExplorer />}
        {tab === "cron" && (
          <Panel
            title={t("Scheduled jobs")}
            note={t("Choose a script, schedule, and the account that runs it")}
            extra={readOnly ? undefined : (
              <Btn
                className="primary"
                disabled={!state.scripts.length}
                onClick={() => setScheduleEditor(null)}
              >
                <CalendarPlus size={16} />
                {t("New schedule")}
              </Btn>
            )}
          >
            {state.schedules.length ? (
              state.schedules.map((schedule) => {
                const script = state.scripts.find(
                  (item) => item.id === schedule.scriptId,
                );
                return (
                  <div className="schedule-row" key={schedule.id}>
                    <div className="service-icon">
                      <Clock3 size={19} />
                    </div>
                    <div className="grow">
                      {/* A schedule without a script runs a command, which says more than its label. */}
                      <b>{script?.name || schedule.command || schedule.label}</b>
                      <small>
                        {schedule.label} · {schedule.expression}{schedule.arguments ? ` · ${schedule.arguments}` : ""}
                      </small>
                    </div>
                    <span
                      className={`badge ${schedule.enabled ? "up" : "down"}`}
                    >
                      {schedule.enabled ? t("Enabled") : t("Paused")}
                    </span>
                    {(schedule.runAs || "user") === "root" && (
                      <span className="badge root">root</span>
                    )}
                    {!readOnly && <RowMenu
                      label={t("Actions for the schedule {name}", { name: script?.name || schedule.command || schedule.label })}
                      disabled={!!busy}
                      items={[
                        { label: t("Edit"), icon: <Pencil size={15} />, onSelect: () => setScheduleEditor(schedule) },
                        {
                          label: schedule.enabled ? t("Pause") : t("Enable"), icon: schedule.enabled ? <Pause size={15} /> : <Play size={15} />,
                          onSelect: () => action(schedule.id, "schedule/toggle", { id: schedule.id }),
                        },
                        {
                          label: t("Delete"), icon: <Trash2 size={15} />, danger: true,
                          onSelect: async () => {
                            if (await appConfirm(t("Delete the schedule for {name} ({label})? Its line is removed from the server's crontab.", { name: script?.name ?? t("the custom command"), label: schedule.label }), t("Delete schedule"), t("Delete"), true))
                              await action(schedule.id, "schedule/delete", { id: schedule.id });
                          },
                        },
                      ]}
                    />}
                  </div>
                );
              })
            ) : (
              <div className="empty-state">
                <Clock3 />
                <h2>{t("No schedules yet")}</h2>
                <p>{t("Create one by selecting a script and when it should run.")}</p>
              </div>
            )}
            <details className="raw-cron">
              <summary>{t("Show full server crontab")}</summary>
              <pre>{state.cron || t("No scheduled jobs.")}</pre>
            </details>
            <details className="raw-cron">
              <summary>{t("Show root schedules and system cron files")}</summary>
              {state.root.available ? (
                <pre>{`${state.root.cron || t("No root crontab entries.")}\n\n--- ${t("System cron files")} ---\n${state.root.system}`}</pre>
              ) : (
                <p className="root-access-note">{t("Root cron access is not enabled yet.")}</p>
              )}
            </details>
          </Panel>
        )}
        {tab === "history" && <HistoryPanel metrics={state.metrics} openLog={(run) => openLogs(t("{name} run", { name: run.scriptName }), "script/log", { id: run.scriptId, runId: run.id })} />}
        {tab === "power" && <PowerPage readOnly={readOnly} />}
        {tab === "alerts" && (
          <Panel title={t("Alert rules")} note={t("Rules are checked every 5 minutes and on each dashboard refresh; cooldowns prevent repeated notifications.")} extra={readOnly ? undefined : <Btn className="primary" onClick={() => setAlertEditor(null)}>{t("New alert")}</Btn>}>
            {(state.alerts || []).map((rule) => <div className="schedule-row" key={rule.id}><div className="grow"><b>{rule.name}</b><small>{describeAlert(rule.metric, rule.threshold)} · {t("cooldown {minutes} min", { minutes: rule.cooldownMinutes })}{rule.lastTriggeredAt ? ` · ${t("last triggered {time}", { time: new Date(rule.lastTriggeredAt).toLocaleString(locale()) })}` : ""}</small></div><span className={`badge ${rule.enabled ? "up" : "down"}`}>{rule.enabled ? t("Enabled") : t("Paused")}</span>{!readOnly && <RowMenu label={t("Actions for the alert {name}", { name: rule.name })} disabled={!!busy} items={[
              { label: t("Edit"), icon: <Pencil size={15} />, onSelect: () => setAlertEditor(rule) },
              { label: t("Delete"), icon: <Trash2 size={15} />, danger: true, onSelect: async () => { if (await appConfirm(t("Delete the alert rule “{name}”?", { name: rule.name }), t("Delete alert"), t("Delete"), true)) await action(rule.id, "alerts/delete", { id: rule.id }); } },
            ]} />}</div>)}
            {!state.alerts?.length && <div className="empty-state"><Thermometer size={22}/><b>{t("No alert rules yet")}</b><p>{t("Add thresholds for server health and jobs.")}</p></div>}
          </Panel>
        )}
        {tab === "settings" && readOnly && <><AppearancePanel /><PasswordForm /></>}
        {tab === "settings" && !readOnly && <><AppearancePanel /><NotificationsPanel /><ServerSettings /><Panel title={t("Storage monitoring")} note={t("Choose which mounted paths appear in capacity cards.")}><div className="panel-body"><Btn onClick={() => setStorageManager(true)}><HardDrive size={16}/>{t("Manage storage paths")}</Btn></div></Panel><DevicePanel devices={state.devices} current={state.device} revoke={(id) => action(id, "device/revoke", { id })} rename={(id, name) => action(id, "device/rename", { id, name })} createCode={async () => { try { setEnrollment(await api("enrollment/create", { minutes: "15" })); setCopied("idle"); } catch (e) { setErr(e instanceof Error ? e.message : t("Error")); } }} /><UsersPanel current={state.user?.name || ""} /><PasswordForm /><ConfigurationPanel refresh={refresh} /></>}
      </main>
      {logs && (
        <LiveLogViewer logs={logs} close={() => setLogs(null)} canStop={!readOnly} />
      )}
      {edit !== undefined && (
        <ScriptForm
          initial={edit}
          folders={state.folders}
          rootAccess={state.rootScript.available}
          rootStop={!!state.rootScript.stop}
          close={() => setEdit(undefined)}
          done={async () => {
            setEdit(undefined);
            await refresh();
          }}
        />
      )}
      {customScriptEditor && (
        <CustomScriptForm
          folders={state.folders}
          rootAccess={state.rootScript.available}
          close={() => setCustomScriptEditor(false)}
          done={async () => {
            setCustomScriptEditor(false);
            await refresh();
          }}
        />
      )}
      {runPrompt && (
        <RunScriptForm
          script={runPrompt}
          close={() => setRunPrompt(null)}
          done={async (script, runId) => {
            setRunPrompt(null);
            setLogs({
              title: t("{name} logs", { name: script.name }),
              path: "script/log",
              request: { id: script.id, runId },
            });
            await refresh();
          }}
        />
      )}
      {scheduleEditor !== undefined && (
        <ScheduleForm
          initial={scheduleEditor}
          scripts={state.scripts}
          rootAccess={state.root.available && state.rootScript.available}
          close={() => setScheduleEditor(undefined)}
          done={async () => {
            setScheduleEditor(undefined);
            await refresh();
          }}
        />
      )}
      {folderEditor && (
        <FolderForm
          close={() => setFolderEditor(false)}
          done={async () => {
            setFolderEditor(false);
            await refresh(true);
          }}
        />
      )}
      {alertEditor !== undefined && <AlertForm initial={alertEditor} close={() => setAlertEditor(undefined)} done={async () => { setAlertEditor(undefined); await refresh(); }} />}
      {storageManager && <StorageManager paths={state.monitoredPaths || state.stats.storage.map((item) => item.path)} close={() => setStorageManager(false)} done={async () => { await refresh(); setStoragePage(0); }} />}
      {enrollment && (
        <Modal title={t("New browser access code")} close={() => setEnrollment(null)}>
          <div className="access-code">
            <p>
              {t("Enter this one-time code on the new browser. It expires at {time}.", { time: new Date(enrollment.expires * 1000).toLocaleTimeString(locale(), {
                hour: "2-digit",
                minute: "2-digit",
              }) })}
            </p>
            <code ref={accessCode}>{enrollment.code}</code>
            <Btn
              className="primary"
              onClick={async () => {
                if (await copyText(enrollment.code)) return setCopied("copied");
                // Leave the code selected so it can be copied from the keyboard.
                const selection = window.getSelection();
                if (accessCode.current && selection) selection.selectAllChildren(accessCode.current);
                setCopied("manual");
              }}
            >
              <Copy size={16} />
              {copied === "copied" ? t("Copied") : copied === "manual" ? t("Selected: press Ctrl+C") : t("Copy code")}
            </Btn>
          </div>
        </Modal>
      )}
      <DialogHost />
    </div>
  );
}
