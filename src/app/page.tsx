"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "@/lib/client-api";
import {
  Box,
  CalendarPlus,
  ClipboardPaste,
  ChevronLeft,
  ChevronDown,
  Circle,
  Clock3,
  Container,
  Copy,
  FileTerminal,
  FilePenLine,
  Folder,
  FolderOpen,
  Gauge,
  HardDrive,
  KeyRound,
  LayoutGrid,
  LayoutList,
  Loader2,
  LogOut,
  MoreHorizontal,
  Play,
  RefreshCw,
  RotateCcw,
  Scissors,
  Server,
  Square,
  Terminal,
  Thermometer,
  Trash2,
} from "lucide-react";
type C = {
  ID: string;
  Names: string;
  Image: string;
  State: string;
  Status: string;
  Ports: string;
  CreatedAt: string;
  Networks: string;
  Mounts: string;
  Size: string;
};
type RunOption = { label: string; value: string; description: string; needsFile?: boolean };
type S = { id: string; name: string; path: string; cron: string; folder?: string; runAs?: "user" | "root"; argumentHint?: string; runOptions?: RunOption[] };
type Schedule = {
  id: string;
  scriptId: string;
  expression: string;
  label: string;
  enabled: boolean;
  runAs?: "user" | "root";
  command?: string;
};
type St = {
  containers: C[];
  scripts: S[];
  schedules: Schedule[];
  folders: string[];
  cron: string;
  devices: Record<string, { name: string; created: string }>;
  host: string;
  time: string;
  root: { available: boolean; cron: string; system: string };
  rootScript: { available: boolean };
  stats: {
    temperatureC: number | null;
    memoryUsedBytes: number;
    memoryTotalBytes: number;
    memoryAvailableBytes: number;
    diskUsedBytes: number;
    diskTotalBytes: number;
    diskUsedPercent: number;
    storage: {
      path: string;
      usedBytes: number | null;
      totalBytes: number | null;
      usedPercent: number | null;
    }[];
    uptimeSeconds: number;
    cpuUsagePercent: number;
    cpuCores: number;
  };
  runs: { id: string; scriptId: string; scriptName: string; startedAt: string; completedAt?: string; exitCode?: number; durationMs?: number; arguments: string; status: "running" | "success" | "failed" }[];
  alerts: { id: string; name: string; metric: string; threshold: number; enabled: boolean; cooldownMinutes: number; lastTriggeredAt?: number }[];
  metrics: { at: number; cpu: number; ram: number; temperature: number | null; disk: number }[];
  cronRuns: { scheduleId: string; label: string; startedAt: string; completedAt?: string; exitCode?: number; status: "running" | "success" | "failed" }[];
  monitoredPaths: string[];
};
type ScriptBrowserData = {
  path: string;
  parent: string | null;
  roots: string[];
  entries: { name: string; path: string; type: "directory" | "script" }[];
};
type FileBrowserData = {
  path: string;
  parent: string | null;
  roots: string[];
  entries: { name: string; path: string; type: "directory" | "file"; size: number | null }[];
};
type DialogRequest = {
  kind: "confirm" | "prompt";
  title: string;
  message: string;
  confirmLabel: string;
  defaultValue?: string;
  danger?: boolean;
  resolve: (value: boolean | string | null) => void;
};
function requestDialog(request: Omit<DialogRequest, "resolve">) {
  return new Promise<boolean | string | null>((resolve) =>
    window.dispatchEvent(new CustomEvent("media-control-dialog", { detail: { ...request, resolve } })),
  );
}
async function appConfirm(message: string, title = "Confirm action", confirmLabel = "Confirm", danger = false) {
  return (await requestDialog({ kind: "confirm", title, message, confirmLabel, danger })) === true;
}
async function appPrompt(message: string, defaultValue = "", title = "Enter a value", confirmLabel = "Continue") {
  const result = await requestDialog({ kind: "prompt", title, message, confirmLabel, defaultValue });
  return typeof result === "string" ? result : null;
}
const Btn = ({
  className = "",
  ...p
}: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button className={`button ${className}`} {...p} />
);
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
    [enrollment, setEnrollment] = useState<{
      code: string;
      expires: number;
    } | null>(null),
    [copied, setCopied] = useState(false),
    [needsSetup, setNeedsSetup] = useState(false),
    [initializing, setInitializing] = useState(true),
    [pendingRequests, setPendingRequests] = useState(0);
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
  const refresh = useCallback(async (silent = false) => {
    try {
      setState(await api("state", undefined, silent));
      setErr("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
      if (!(e instanceof ApiError) || e.code !== "HOST_UNAVAILABLE") setState(null);
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
    const poll = async () => {
      if (document.hidden || polling) return;
      polling = true;
      try { await refresh(true); } finally { polling = false; }
    };
    void poll();
    const x = setInterval(poll, 15000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      clearInterval(x);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [refresh]);
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
      const folder = script.folder || "Unfiled";
      groups.set(folder, [...(groups.get(folder) || []), script]);
    }
    return [...groups.entries()].sort(([a], [b]) => {
      if (a === "Unfiled") return 1;
      if (b === "Unfiled") return -1;
      return a.localeCompare(b);
    });
  }, [state]);
  async function action(key: string, path: string, body: unknown) {
    try {
      setBusy(key);
      await api(path, body);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy("");
    }
  }
  async function startScript(script: S) {
    try {
      setBusy(script.id);
      const result = await api("script/run", { id: script.id });
      setLogs({
        title: `${script.name} logs`,
        path: "script/log",
        request: { id: script.id, runId: result.run.id },
      });
      await refresh();
    } catch (reason) {
      setErr(reason instanceof Error ? reason.message : "Could not start script");
    } finally {
      setBusy("");
    }
  }
  function openLogs(title: string, path: string, body: unknown) {
    setLogs({ title, path, request: body });
  }
  if (initializing) return <LoadingScreen />;
  if (needsSetup)
    return <Setup done={() => { setNeedsSetup(false); void refresh(); }} loading={pendingRequests > 0} />;
  if (!state && err.includes("Server unavailable"))
    return <ConnectionUnavailable error={err} retry={() => void refresh()} loading={pendingRequests > 0} />;
  if (!state)
    return <Login error={err} done={refresh} loading={pendingRequests > 0} />;
  const nav = [
    ["overview", LayoutGrid, "Overview"],
    ["containers", Container, "Containers"],
    ["scripts", FileTerminal, "Scripts"],
    ["files", FolderOpen, "Files"],
    ["cron", Clock3, "Schedules"],
    ["history", Clock3, "History"],
    ["alerts", Thermometer, "Alerts"],
    ["settings", KeyRound, "Settings"],
  ] as const;
  return (
    <div className="shell">
      {pendingRequests > 0 && <AppLoading />}
      <aside>
        <div className="brand">
          <span>
            <img src="/icon.svg" alt="" />
          </span>
          <b>Linux Server Control</b>
        </div>
        <nav>
          {nav.map(([id, Icon, label]) => (
            <button
              key={id}
              className={tab === id ? "active" : ""}
              onClick={() => setTab(id)}
            >
              <Icon size={18} />
              {label}
            </button>
          ))}
        </nav>
        <div className="server">
          <i />
          <div>
            <b>Server connected</b>
            <small>{state.host}</small>
          </div>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <h1>
              {
                {
                  overview: "Overview",
                  containers: "Containers",
                  scripts: "Scripts",
                  cron: "Schedules",
                  history: "History",
                  alerts: "Alerts",
                  settings: "Settings",
                }[tab]
              }
            </h1>
            <p>Updated {state.time}</p>
          </div>
          <div className="actions">
            <Btn onClick={() => refresh()}>
              <RefreshCw size={16} />
              Refresh
            </Btn>
            <Btn
              aria-label="Log out"
              onClick={async () => {
                await api("logout", {});
                setState(null);
              }}
            >
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
        {tab === "overview" && <Overview state={state} active={active} stopped={stopped} openLogs={openLogs} />}
        {tab === "containers" && (
          <>
            <section className="metrics">
              <Metric
                label="Temperature"
                value={state.stats.temperatureC === null ? "Unavailable" : `${state.stats.temperatureC.toFixed(1)} °C`}
                icon={<Thermometer />}
              />
              <Metric
                label="RAM"
                value={`${formatBytes(state.stats.memoryUsedBytes)} / ${formatBytes(state.stats.memoryTotalBytes)}`}
                note={formatPercent(state.stats.memoryUsedBytes, state.stats.memoryTotalBytes)}
                icon={<Gauge />}
              />
              <Metric
                label="System disk"
                value={`${formatBytes(state.stats.diskTotalBytes - state.stats.diskUsedBytes)} free`}
                note={`${state.stats.diskUsedPercent}% used · ${formatBytes(state.stats.diskTotalBytes)} total`}
                icon={<HardDrive />}
              />
              {visibleStorage.map((drive) => (
                <Metric
                  key={drive.path}
                  label={`Storage (${drive.path})`}
                  value={drive.usedPercent === null || drive.usedBytes === null || drive.totalBytes === null
                    ? "Unavailable"
                    : `${formatBytes(drive.totalBytes - drive.usedBytes)} free`}
                  note={drive.usedBytes === null || drive.totalBytes === null
                    ? "Check MONITORED_PATHS"
                    : `${drive.usedPercent}% used · ${formatBytes(drive.totalBytes)} total`}
                  icon={<HardDrive />}
                />
              ))}
              <Metric
                label="CPU usage"
                value={`${state.stats.cpuUsagePercent.toFixed(1)}%`}
                note={`${state.stats.cpuCores} logical cores`}
                icon={<Gauge />}
              />
              <Metric label="Uptime" value={formatUptime(state.stats.uptimeSeconds)} icon={<Clock3 />} />
              <Metric
                label="Containers"
                value={`${active} running`}
                note={`${state.containers.length} total · ${stopped} stopped`}
                icon={<Container />}
              />
            </section>
            <div className="actions" style={{ marginBottom: 18 }}><Btn onClick={() => setStorageManager(true)}><HardDrive size={16} />Manage storage paths</Btn></div>
            {state.stats.storage.length > storagePerPage && <div className="actions" style={{ marginBottom: 18 }}><Btn disabled={storagePage === 0} onClick={() => setStoragePage((page) => page - 1)}>Previous storage</Btn><small>Storage {storagePage + 1} of {storagePages}</small><Btn disabled={storagePage + 1 >= storagePages} onClick={() => setStoragePage((page) => page + 1)}>Next storage</Btn></div>}
            <Panel
              title="All containers"
              note="Live Docker status and controls"
              extra={
                <div className="container-filters" aria-label="Filter containers">
                  {([
                    ["all", "All", state.containers.length],
                    ["running", "Running", active],
                    ["stopped", "Stopped", stopped],
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
                  busy={busy}
                  act={action}
                  logs={openLogs}
                />
              ))}
              {!visibleContainers.length && (
                <div className="empty-state">
                  <Container size={22} />
                  <b>No {containerFilter === "all" ? "" : `${containerFilter} `}containers</b>
                  <p>
                    {containerFilter === "stopped"
                      ? "All containers are currently running."
                      : "No containers match this filter."}
                  </p>
                </div>
              )}
            </Panel>
          </>
        )}
        {tab === "scripts" && (
          <Panel
            title="Quick actions"
            note="Run and schedule approved scripts"
            extra={
              <div className="actions">
                <Btn onClick={() => setFolderEditor(true)}>
                  <Folder size={16} />
                  New folder
                </Btn>
                <Btn className="primary" onClick={() => setEdit(null)}>
                  Add script
                </Btn>
                <Btn onClick={() => setCustomScriptEditor(true)}>
                  New custom script
                </Btn>
              </div>
            }
          >
            {scriptFolders.length ? (
              scriptFolders.map(([folder, scripts]) => (
                <details className="script-folder" key={folder}>
                  <summary>
                    <Folder size={18} />
                    <span>
                      <b>{folder}</b>
                      <small>{scripts.length} script{scripts.length === 1 ? "" : "s"}</small>
                    </span>
                    <ChevronDown className="chevron" size={18} />
                  </summary>
                  {scripts.map((s) => (
                    <div className="script-row" key={s.id}>
                      <div className="service-icon">
                        <FileTerminal size={19} />
                      </div>
                      <div className="grow">
                        <b>{s.name}</b>
                        <small>{s.path}</small>
                        {(() => { const schedule = state.schedules.find((item) => item.scriptId === s.id); const lastRun = state.runs.find((item) => item.scriptId === s.id); return <small>{schedule ? `${schedule.enabled ? "Scheduled" : "Schedule paused"}: ${schedule.expression}` : "Not scheduled"}{lastRun ? ` · last run ${lastRun.status}` : " · never run"}</small>; })()}
                        {s.runAs === "root" && <span className="badge root">root</span>}
                      </div>
                      <div className="actions">
                        <Btn
                          disabled={!!busy}
                          onClick={() =>
                            s.runOptions?.length
                              ? setRunPrompt(s)
                              : startScript(s)
                          }
                        >
                          <Play size={15} />
                          Run
                        </Btn>
                        <Btn
                          onClick={() => openLogs(s.name, "script/log", { id: s.id })}
                        >
                          Logs
                        </Btn>
                        <Btn onClick={() => { const schedule = state.schedules.find((item) => item.scriptId === s.id); setScheduleEditor(schedule || { id: "", scriptId: s.id, expression: "0 3 * * *", label: `Run ${s.name}`, enabled: true, runAs: s.runAs || "user" }); }}>Schedule</Btn>
                        <Btn onClick={() => setEdit(s)}>Edit</Btn>
                        <Btn
                          className="danger"
                          disabled={!!busy}
                          onClick={async () => {
                            if (await appConfirm(`Delete “${s.name}” and its scheduled jobs?`, "Delete script", "Delete", true))
                              await action(s.id, "script/delete", { id: s.id });
                          }}
                        >
                          <Trash2 size={15} />
                          Delete
                        </Btn>
                      </div>
                    </div>
                  ))}
                </details>
              ))
            ) : (
              <div className="empty-state">
                <FileTerminal size={22} />
                <b>No scripts yet</b>
                <p>Add a script to run it or create a schedule.</p>
              </div>
            )}
          </Panel>
        )}
        {tab === "files" && <FileExplorer />}
        {tab === "cron" && (
          <Panel
            title="Scheduled jobs"
            note="Choose a script, schedule, and the account that runs it"
            extra={
              <Btn
                className="primary"
                disabled={!state.scripts.length}
                onClick={() => setScheduleEditor(null)}
              >
                <CalendarPlus size={16} />
                New schedule
              </Btn>
            }
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
                      <b>{script?.name || schedule.label}</b>
                      <small>
                        {schedule.label} · {schedule.expression}
                      </small>
                    </div>
                    <span
                      className={`badge ${schedule.enabled ? "up" : "down"}`}
                    >
                      {schedule.enabled ? "Enabled" : "Paused"}
                    </span>
                    {(schedule.runAs || "user") === "root" && (
                      <span className="badge root">root</span>
                    )}
                    <div className="actions">
                      <Btn onClick={() => setScheduleEditor(schedule)}>Edit</Btn>
                      <Btn
                        onClick={() =>
                          action(schedule.id, "schedule/toggle", {
                            id: schedule.id,
                          })
                        }
                      >
                        {schedule.enabled ? "Pause" : "Enable"}
                      </Btn>
                      <Btn
                        className="danger"
                        onClick={() =>
                          action(schedule.id, "schedule/delete", {
                            id: schedule.id,
                          })
                        }
                      >
                        <Trash2 size={15} />
                        Delete
                      </Btn>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="empty-state">
                <Clock3 />
                <h2>No schedules yet</h2>
                <p>Create one by selecting a script and when it should run.</p>
              </div>
            )}
            <details className="raw-cron">
              <summary>Show full server crontab</summary>
              <pre>{state.cron || "No scheduled jobs."}</pre>
            </details>
            <details className="raw-cron">
              <summary>Show root schedules and system cron files</summary>
              {state.root.available ? (
                <pre>{`${state.root.cron || "No root crontab entries."}\n\n--- System cron files ---\n${state.root.system}`}</pre>
              ) : (
                <p className="root-access-note">Root cron access is not enabled yet.</p>
              )}
            </details>
          </Panel>
        )}
        {tab === "history" && <HistoryPanel runs={state.runs || []} cronRuns={state.cronRuns || []} metrics={state.metrics || []} openLog={(run) => openLogs(`${run.scriptName} run`, "script/log", { id: run.scriptId, runId: run.id })} />}
        {tab === "alerts" && (
          <Panel title="Alert rules" note="Threshold checks run with each dashboard refresh; cooldowns prevent repeated notifications." extra={<Btn className="primary" onClick={() => setAlertEditor(null)}>New alert</Btn>}>
            {(state.alerts || []).map((rule) => <div className="schedule-row" key={rule.id}><div className="grow"><b>{rule.name}</b><small>{rule.metric} ≥ {rule.threshold} · cooldown {rule.cooldownMinutes} min{rule.lastTriggeredAt ? ` · last triggered ${new Date(rule.lastTriggeredAt).toLocaleString()}` : ""}</small></div><span className={`badge ${rule.enabled ? "up" : "down"}`}>{rule.enabled ? "Enabled" : "Paused"}</span><div className="actions"><Btn onClick={() => setAlertEditor(rule)}>Edit</Btn><Btn className="danger" onClick={() => action(rule.id, "alerts/delete", { id: rule.id })}><Trash2 size={15}/>Delete</Btn></div></div>)}
            {!state.alerts?.length && <div className="empty-state"><Thermometer size={22}/><b>No alert rules yet</b><p>Add thresholds for server health and jobs.</p></div>}
          </Panel>
        )}
        {tab === "settings" && <><ServerSettings /><Panel title="Storage monitoring" note="Choose which mounted paths appear in capacity cards."><Btn onClick={() => setStorageManager(true)}><HardDrive size={16}/>Manage storage paths</Btn></Panel><DevicePanel devices={state.devices} revoke={(id) => action(id, "device/revoke", { id })} createCode={async () => { try { setEnrollment(await api("enrollment/create", { minutes: "15" })); setCopied(false); } catch (e) { setErr(e instanceof Error ? e.message : "Error"); } }} /><PasswordForm /><ConfigurationPanel refresh={refresh} /></>}
      </main>
      {logs && (
        <LiveLogViewer logs={logs} close={() => setLogs(null)} />
      )}
      {edit !== undefined && (
        <ScriptForm
          initial={edit}
          folders={state.folders}
          rootAccess={state.rootScript.available}
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
              title: `${script.name} logs`,
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
          rootAccess={state.root.available}
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
        <Modal title="New browser access code" close={() => setEnrollment(null)}>
          <div className="access-code">
            <p>
              Enter this one-time code on the new browser. It expires at{" "}
              {new Date(enrollment.expires * 1000).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}.
            </p>
            <code>{enrollment.code}</code>
            <Btn
              className="primary"
              onClick={async () => {
                await navigator.clipboard.writeText(enrollment.code);
                setCopied(true);
              }}
            >
              <Copy size={16} />
              {copied ? "Copied" : "Copy code"}
            </Btn>
          </div>
        </Modal>
      )}
      <DialogHost />
    </div>
  );
}
function Panel({
  title,
  note,
  extra,
  children,
}: {
  title: string;
  note: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>{title}</h2>
          <p>{note}</p>
        </div>
        {extra}
      </div>
      {children}
    </section>
  );
}
function Metric({
  label,
  value,
  note,
  icon,
}: {
  label: string;
  value: string;
  note?: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="metric">
      <span>{icon}</span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
        {note && <em>{note}</em>}
      </div>
    </div>
  );
}
function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}
function formatPercent(used: number, total: number) {
  return total > 0 ? `${Math.round((used / total) * 100)}% used` : "Unavailable";
}
function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
function ContainerRow({
  c,
  busy,
  act,
  logs,
}: {
  c: C;
  busy: string;
  act: (k: string, p: string, b: unknown) => void;
  logs: (t: string, p: string, b: unknown) => void;
}) {
  const up = c.State === "running",
    key = (a: string) => `${c.ID}-${a}`;
  return (
    <details className="container-row">
      <summary>
        <div className="service-icon">
          <Container size={20} />
        </div>
        <div className="service-main">
          <b>{c.Names}</b>
          <span>{c.Image}</span>
        </div>
        <span className={`badge ${up ? "up" : "down"}`}>
          <Circle size={8} fill="currentColor" />
          {up ? "Up" : "Down"}
        </span>
        <div className="uptime">{c.Status}</div>
        <ChevronDown className="chevron" size={18} />
      </summary>
      <div className="details">
        <dl>
          {[
            ["Container ID", c.ID],
            ["Created", c.CreatedAt],
            ["Networks", c.Networks],
            ["Ports", c.Ports || "No published ports"],
            ["Mounts", c.Mounts],
            ["Size", c.Size],
          ].map(([a, b]) => (
            <div key={a}>
              <dt>{a}</dt>
              <dd>{b || "—"}</dd>
            </div>
          ))}
        </dl>
        <div className="actions">
          <Btn
            onClick={() =>
              logs(c.Names, "container", { name: c.Names, action: "logs" })
            }
          >
            <Terminal size={15} />
            Logs
          </Btn>
          {up ? (
            <>
              <Btn
                disabled={!!busy}
                onClick={() =>
                  act(key("restart"), "container", {
                    name: c.Names,
                    action: "restart",
                  })
                }
              >
                {busy === key("restart") ? (
                  <Loader2 className="spin" />
                ) : (
                  <RotateCcw size={15} />
                )}
                Restart
              </Btn>
              <Btn
                className="danger"
                disabled={!!busy}
                onClick={() =>
                  act(key("stop"), "container", {
                    name: c.Names,
                    action: "stop",
                  })
                }
              >
                <Square size={15} />
                Stop
              </Btn>
            </>
          ) : (
            <Btn
              className="primary"
              disabled={!!busy}
              onClick={() =>
                act(key("start"), "container", {
                  name: c.Names,
                  action: "start",
                })
              }
            >
              <Play size={15} />
              Start
            </Btn>
          )}
        </div>
      </div>
    </details>
  );
}
function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="modal-bg" onMouseDown={close}>
      <section className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2>{title}</h2>
          <Btn onClick={close}>Close</Btn>
        </div>
        {children}
      </section>
    </div>
  );
}
function DialogHost() {
  const [request, setRequest] = useState<DialogRequest | null>(null);
  useEffect(() => {
    const open = (event: Event) => setRequest((event as CustomEvent<DialogRequest>).detail);
    window.addEventListener("media-control-dialog", open);
    return () => window.removeEventListener("media-control-dialog", open);
  }, []);
  if (!request) return null;
  const finish = (value: boolean | string | null) => {
    request.resolve(value);
    setRequest(null);
  };
  return request.kind === "prompt" ? (
    <PromptDialog request={request} finish={finish} />
  ) : (
    <Modal title={request.title} close={() => finish(false)}>
      <p>{request.message}</p>
      <div className="actions">
        <Btn onClick={() => finish(false)}>Cancel</Btn>
        <Btn className={request.danger ? "danger" : "primary"} onClick={() => finish(true)}>{request.confirmLabel}</Btn>
      </div>
    </Modal>
  );
}
function PromptDialog({ request, finish }: { request: DialogRequest; finish: (value: string | null) => void }) {
  const [value, setValue] = useState(request.defaultValue || "");
  return <Modal title={request.title} close={() => finish(null)}>
    <form onSubmit={(event) => { event.preventDefault(); if (value.trim()) finish(value); }}>
      <label>{request.message}<input autoFocus value={value} onChange={(event) => setValue(event.target.value)} /></label>
      <div className="actions"><Btn type="button" onClick={() => finish(null)}>Cancel</Btn><Btn className="primary" disabled={!value.trim()}>{request.confirmLabel}</Btn></div>
    </form>
  </Modal>;
}
function LiveLogViewer({
  logs,
  close,
}: {
  logs: { title: string; path: string; request: unknown };
  close: () => void;
}) {
  const [body, setBody] = useState("Loading logs…"),
    [live, setLive] = useState(true),
    [loading, setLoading] = useState(false);
  const refreshLogs = useCallback(async () => {
    try {
      setLoading(true);
      const result = await api(logs.path, logs.request, true);
      setBody(result.output || "No logs available.");
    } catch (reason) {
      setBody(reason instanceof Error ? reason.message : "Could not load logs");
    } finally {
      setLoading(false);
    }
  }, [logs]);
  useEffect(() => {
    if (!live) return;
    refreshLogs();
    const interval = window.setInterval(refreshLogs, 2000);
    return () => window.clearInterval(interval);
  }, [live, refreshLogs]);
  return (
    <Modal title={logs.title} close={close}>
      <div className="live-log-controls">
        <span className={live ? "live-status" : ""}>
          {loading && <Loader2 className="spin" size={14} />}
          {live ? "Live updates every 2 seconds" : "Live updates stopped"}
        </span>
        <Btn type="button" onClick={() => setLive((current) => !current)}>
          {live ? <Square size={15} /> : <Play size={15} />}
          {live ? "Stop live" : "Start live"}
        </Btn>
      </div>
      <pre>{body}</pre>
    </Modal>
  );
}
function ScriptForm({
  initial,
  folders,
  rootAccess,
  close,
  done,
}: {
  initial: S | null;
  folders: string[];
  rootAccess: boolean;
  close: () => void;
  done: () => void;
}) {
  const [err, setErr] = useState(""),
    [scriptPath, setScriptPath] = useState(initial?.path || ""),
    [showBrowser, setShowBrowser] = useState(false),
    [hasRunOptions, setHasRunOptions] = useState(!!initial?.runOptions?.length),
    [runOptions, setRunOptions] = useState<RunOption[]>(
      initial?.runOptions ||
        (initial?.argumentHint
          ? [{ label: "Default option", value: initial.argumentHint, description: "Imported from the previous argument prompt" }]
          : []),
    );
  return (
    <Modal title={initial ? "Edit script" : "Add script"} close={close}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api(
              "script/save",
              Object.fromEntries(new FormData(e.currentTarget)),
            );
            done();
          } catch (x) {
            setErr(x instanceof Error ? x.message : "Error");
          }
        }}
      >
        <input type="hidden" name="id" defaultValue={initial?.id} />
        <label>
          Name
          <input name="name" required defaultValue={initial?.name} />
        </label>
        <label>
          Server path
          <div className="path-input">
            <input
              name="path"
              required
              value={scriptPath}
              onChange={(event) => setScriptPath(event.target.value)}
            />
            <Btn type="button" onClick={() => setShowBrowser((open) => !open)}>
              <FolderOpen size={16} />
              Browse
            </Btn>
          </div>
        </label>
        {showBrowser && (
          <ScriptBrowser
            choose={(path) => {
              setScriptPath(path);
              setShowBrowser(false);
            }}
          />
        )}
        <label>
          Folder
          <select
            name="folder"
            defaultValue={initial?.folder}
          >
            <option value="">Unfiled</option>
            {folders.map((folder) => (
              <option key={folder} value={folder}>
                {folder}
              </option>
            ))}
          </select>
          <small>Create folders from the Scripts page.</small>
        </label>
        <label>
          Run as
          <select name="runAs" defaultValue={initial?.runAs || "user"}>
            <option value="user">SSH user</option>
            <option value="root" disabled={!rootAccess}>root{rootAccess ? "" : " (not enabled)"}</option>
          </select>
          <small>Root is available only for script folders approved by the server helper.</small>
        </label>
        <input type="hidden" name="runOptions" value={hasRunOptions ? JSON.stringify(runOptions) : "[]"} />
        <label className="option-toggle">
          <input
            type="checkbox"
            checked={hasRunOptions}
            onChange={(event) => {
              setHasRunOptions(event.target.checked);
              if (event.target.checked && !runOptions.length)
                setRunOptions([{ label: "", value: "", description: "", needsFile: false }]);
            }}
          />
          Ask me to choose an option before running
        </label>
        {hasRunOptions && (
          <section className="run-options-editor">
            <div className="run-options-head">
              <div>
                <b>Run options</b>
                <small>Each option becomes an item in the Run dropdown.</small>
              </div>
              <Btn
                type="button"
                onClick={() => setRunOptions([...runOptions, { label: "", value: "", description: "", needsFile: false }])}
              >
                Add option
              </Btn>
            </div>
            {runOptions.map((option, index) => (
              <div className="run-option-fields" key={index}>
                <input
                  aria-label="Option name"
                  placeholder="Option name"
                  value={option.label}
                  onChange={(event) => setRunOptions(runOptions.map((item, i) => i === index ? { ...item, label: event.target.value } : item))}
                />
                <input
                  aria-label="Arguments"
                  placeholder="Arguments, e.g. --latest --yes"
                  value={option.value}
                  onChange={(event) => setRunOptions(runOptions.map((item, i) => i === index ? { ...item, value: event.target.value } : item))}
                />
                <input
                  aria-label="Explanation"
                  placeholder="Short explanation"
                  value={option.description}
                  onChange={(event) => setRunOptions(runOptions.map((item, i) => i === index ? { ...item, description: event.target.value } : item))}
                />
                <label className="option-file-toggle">
                  <input
                    type="checkbox"
                    checked={!!option.needsFile}
                    onChange={(event) => setRunOptions(runOptions.map((item, i) => i === index ? { ...item, needsFile: event.target.checked } : item))}
                  />
                  Requires file
                </label>
                <Btn
                  type="button"
                  className="danger"
                  aria-label={`Remove ${option.label || "option"}`}
                  disabled={runOptions.length === 1}
                  onClick={() => setRunOptions(runOptions.filter((_, i) => i !== index))}
                >
                  <Trash2 size={15} />
                </Btn>
              </div>
            ))}
          </section>
        )}
        {err && <div className="alert">{err}</div>}
        <Btn className="primary">Save</Btn>
      </form>
    </Modal>
  );
}
function CustomScriptForm({
  folders,
  rootAccess,
  close,
  done,
}: {
  folders: string[];
  rootAccess: boolean;
  close: () => void;
  done: () => void;
}) {
  const [directory, setDirectory] = useState(""),
    [showBrowser, setShowBrowser] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal title="New custom script" close={close}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            await api(
              "script/create-custom",
              Object.fromEntries(new FormData(event.currentTarget)),
            );
            done();
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : "Could not create script");
          }
        }}
      >
        <label>
          Name
          <input name="name" required maxLength={80} placeholder="My maintenance task" />
        </label>
        <label>
          Script filename
          <input name="filename" required pattern="[A-Za-z0-9][A-Za-z0-9._-]*\\.sh" placeholder="maintenance.sh" />
          <small>Only letters, numbers, dots, dashes, and underscores. The filename must end in .sh.</small>
        </label>
        <label>
          Server folder
          <div className="path-input">
            <input name="directory" required value={directory} onChange={(event) => setDirectory(event.target.value)} placeholder="Choose an allowed folder" />
            <Btn type="button" onClick={() => setShowBrowser((open) => !open)}>
              <FolderOpen size={16} />Browse
            </Btn>
          </div>
        </label>
        {showBrowser && (
          <DirectoryBrowser
            choose={(path) => {
              setDirectory(path);
              setShowBrowser(false);
            }}
          />
        )}
        <label>
          Dashboard folder
          <select name="folder" defaultValue="">
            <option value="">Unfiled</option>
            {folders.map((folder) => <option key={folder} value={folder}>{folder}</option>)}
          </select>
        </label>
        <label>
          Run as
          <select name="runAs" defaultValue="user">
            <option value="user">SSH user</option>
            <option value="root" disabled={!rootAccess}>root{rootAccess ? "" : " (not enabled)"}</option>
          </select>
          <small>Root scripts must be created inside a folder approved by the server helper.</small>
        </label>
        <label>
          Script content
          <textarea name="content" required spellCheck={false} defaultValue={'#!/usr/bin/env bash\nset -eu\n\n# Add commands here\n'} />
          <small>The script runs as the dashboard SSH user. It is saved as an executable file inside the selected allowed folder.</small>
        </label>
        {error && <div className="alert">{error}</div>}
        <Btn className="primary">Create script</Btn>
      </form>
    </Modal>
  );
}
function RunScriptForm({
  script,
  close,
  done,
}: {
  script: S;
  close: () => void;
  done: (script: S, runId: string) => void;
}) {
  const [error, setError] = useState(""),
    [selected, setSelected] = useState("0"),
    [selectedFile, setSelectedFile] = useState(""),
    [showFileBrowser, setShowFileBrowser] = useState(false),
    options = script.runOptions || [];
  const option = options[Number(selected)];
  return (
    <Modal title={`Run ${script.name}`} close={close}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            const result = await api("script/run", { id: script.id, option: selected, file: selectedFile });
            done(script, result.run.id);
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : "Could not start script");
          }
        }}
      >
        <label>
          Choose an option
          <select
            autoFocus
            value={selected}
            onChange={(event) => {
              setSelected(event.target.value);
              setSelectedFile("");
              setShowFileBrowser(false);
            }}
          >
            {options.map((option, index) => (
              <option key={`${option.label}-${index}`} value={index}>{option.label}</option>
            ))}
          </select>
          <small>{option?.description || option?.value}</small>
        </label>
        {option?.needsFile && (
          <section className="run-file-picker">
            <b>Select a file</b>
            <small>The selected path is inserted after <code>--file</code>, before confirmation flags such as <code>--yes</code>.</small>
            {selectedFile && <code>{selectedFile}</code>}
            <Btn type="button" onClick={() => setShowFileBrowser((open) => !open)}>
              <FolderOpen size={16} />
              {selectedFile ? "Change file" : "Choose file"}
            </Btn>
            {showFileBrowser && (
              <FileBrowser
                choose={(path) => {
                  setSelectedFile(path);
                  setShowFileBrowser(false);
                }}
              />
            )}
          </section>
        )}
        {error && <div className="alert">{error}</div>}
        <Btn className="primary" disabled={!!option?.needsFile && !selectedFile}>Run script</Btn>
      </form>
    </Modal>
  );
}
function useDirectory<T>(endpoint: string, directory: string, includeSizes = false, options: Record<string, unknown> = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [sizesLoading, setSizesLoading] = useState(false);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setSizesLoading(false);
    setError("");
    try {
      const result = await api(endpoint, { path: directory, ...options }, true);
      if (current !== generation.current) return;
      setData(result);
      setLoading(false);
      if (includeSizes && result.entries.some((entry: FileBrowserData["entries"][number]) => entry.type === "directory")) {
        setSizesLoading(true);
        try {
          const measured = await api("file/sizes", { path: result.path }, true);
          if (current === generation.current) {
            const entries = result.entries.map((entry: FileBrowserData["entries"][number]) =>
              entry.type === "directory" ? { ...entry, size: measured.sizes[entry.path] ?? null } : entry);
            if (options.sort === "size")
              entries.sort((a: FileBrowserData["entries"][number], b: FileBrowserData["entries"][number]) =>
                (b.size ?? -1) - (a.size ?? -1) || a.name.localeCompare(b.name));
            setData({ ...result, entries });
          }
        } catch {
          // Size failures must not hide an otherwise readable directory.
        } finally {
          if (current === generation.current) setSizesLoading(false);
        }
      }
    } catch (reason) {
      if (current === generation.current)
        setError(reason instanceof Error ? reason.message : "Could not read folder");
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [endpoint, directory, includeSizes, JSON.stringify(options)]);
  useEffect(() => { load(); return () => { generation.current++; }; }, [load]);
  return { data, error, setError, loading, sizesLoading, load };
}
function currentLocation(data: FileBrowserData | ScriptBrowserData | null, directory: string) {
  const current = directory || data?.path || "";
  return data?.roots.filter((root) => current === root || current.startsWith(root + "/"))
    .sort((a, b) => b.length - a.length)[0] || data?.roots[0] || "";
}
function FileExplorer() {
  const [directory, setDirectory] = useState(""),
    [view, setView] = useState<"grid" | "list">("list"),
    [editor, setEditor] = useState<{ path: string; content: string } | null>(null),
    [opening, setOpening] = useState(""),
    [menuPath, setMenuPath] = useState<string | null>(null),
    [search, setSearch] = useState(""), [sort, setSort] = useState("name"), [offset, setOffset] = useState(0),
    [clipboard, setClipboard] = useState<{
      path: string;
      action: "copy" | "move";
      name: string;
    } | null>(null);
  const { data, error, setError, loading, sizesLoading, load } = useDirectory<FileBrowserData & { total?: number; offset?: number; limit?: number }>("file/browse", directory, true, { search, sort, offset, limit: 100 });
  function navigate(path: string) {
    setMenuPath(null);
    setOffset(0);
    setDirectory(path);
  }
  async function operate(
    action: "delete" | "copy" | "move" | "rename",
    source: string,
    destination = "",
    name = "",
  ) {
    try {
      setOpening(source);
      setMenuPath(null);
      await api("file/operation", { action, source, destination, name });
      if (action === "move" || action === "delete") setClipboard(null);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not change file");
    } finally { setOpening(""); }
  }
  async function removeEntry(entry: FileBrowserData["entries"][number]) {
    const description = entry.type === "directory"
      ? `Delete folder ${entry.path} and ALL its contents? This permanently deletes files from the server.`
      : `Delete file ${entry.path}? This cannot be undone.`;
    if (await appConfirm(description, `Delete ${entry.type}`, "Delete", true)) await operate("delete", entry.path);
  }
  async function renameEntry(entry: FileBrowserData["entries"][number]) {
    const name = (await appPrompt(`Rename ${entry.name} to:`, entry.name, "Rename item", "Rename"))?.trim();
    if (name && name !== entry.name) await operate("rename", entry.path, "", name);
  }
  async function paste() {
    if (!clipboard || !data) return;
    await operate(clipboard.action, clipboard.path, data.path);
  }
  async function openFile(path: string) {
    try {
      setOpening(path);
      const result = await api("file/read", { path });
      setEditor(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not open file");
    } finally {
      setOpening("");
    }
  }
  async function create(kind: "file" | "folder") {
    if (!data) return;
    const name = (await appPrompt(`Enter the new ${kind} name:`, "", `New ${kind}`, `Create ${kind}`))?.trim();
    if (!name) return;
    try { setOpening(name); await api("file/create", { path: data.path, name, kind }); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create item"); }
    finally { setOpening(""); }
  }
  return (
    <>
      <Panel
        title="File explorer"
        note="Browse and edit files under /home and /mnt"
        extra={
          <div className="actions">
            {(data?.roots.length || 0) > 1 && (
              <select className="file-explorer-roots" aria-label="Location" value={currentLocation(data, directory)} onChange={(event) => navigate(event.target.value)}>
                {data?.roots.map((root) => <option key={root} value={root}>{root}</option>)}
              </select>
            )}
            <div className="file-view-toggle" aria-label="File view">
              <button
                type="button"
                className={view === "grid" ? "active" : ""}
                aria-label="Grid view"
                aria-pressed={view === "grid"}
                title="Grid view"
                onClick={() => setView("grid")}
              >
                <LayoutGrid size={16} />
              </button>
              <button
                type="button"
                className={view === "list" ? "active" : ""}
                aria-label="List view"
                aria-pressed={view === "list"}
                title="List view"
                onClick={() => setView("list")}
              >
                <LayoutList size={16} />
              </button>
            </div>
            <Btn disabled={!clipboard || !!opening || !data} onClick={paste} title={clipboard ? `Paste ${clipboard.name}` : "Copy or cut a file first"}>
              <ClipboardPaste size={16} />Paste
            </Btn>
            <Btn disabled={!data || !!opening} onClick={() => create("folder")}><Folder size={16} />New folder</Btn>
            <Btn disabled={!data || !!opening} onClick={() => create("file")}><FileTerminal size={16} />New file</Btn>
            <Btn onClick={load}><RefreshCw size={16} />Refresh</Btn>
          </div>
        }
      >
        <form
          className="file-explorer-path"
          onSubmit={(event) => {
            event.preventDefault();
            const requested = String(new FormData(event.currentTarget).get("path") || "").trim();
            if (requested) navigate(requested);
          }}
        >
          <input
            aria-label="Folder path"
            key={data?.path}
            name="path"
            defaultValue={data?.path || ""}
            placeholder="/home/folder or /mnt/folder"
            spellCheck={false}
          />
          <Btn disabled={loading}>Go</Btn>
        </form>
        <div className="file-explorer-tools">
          <input aria-label="Search files" value={search} onChange={(event) => { setSearch(event.target.value); setOffset(0); }} placeholder="Search this folder" />
          <select aria-label="Sort files" value={sort} onChange={(event) => { setSort(event.target.value); setOffset(0); }}><option value="name">Sort by name</option><option value="size">Sort by size</option></select>
          <small>Folder sizes are calculated on demand.</small>
        </div>
        {data?.parent && (
          <button type="button" className="file-explorer-up" onClick={() => navigate(data.parent!)}>
            <ChevronLeft size={16} /> Up one folder
          </button>
        )}
        {loading && !error && <div className="empty-state"><Loader2 className="spin" /><b>Loading files…</b></div>}
        {error && <div className="alert">{error}</div>}
        {!loading && !error && data?.entries.length ? (
          <div className={`file-explorer-grid ${view}`}>
          {data.entries.map((entry) => (
          <article className={`file-explorer-card ${entry.type}`} key={entry.path}>
            <button
              type="button"
              className="file-explorer-open"
              onClick={() => entry.type === "directory" ? navigate(entry.path) : openFile(entry.path)}
            >
              {entry.type === "directory" ? <Folder size={34} /> : <FileTerminal size={30} />}
              <span title={entry.name}>{entry.name}</span>
              <small>
                {entry.size === null
                  ? (sizesLoading ? "Calculating size…" : "Size unavailable")
                  : `${entry.type === "directory" ? "Folder uses" : "File size"}: ${formatBytes(entry.size)}`}
              </small>
            </button>
            <div className="file-explorer-menu">
              <button
                type="button"
                className="file-explorer-menu-trigger"
                aria-label={`Actions for ${entry.name}`}
                aria-expanded={menuPath === entry.path}
                disabled={!!opening}
                onClick={() => setMenuPath((open) => open === entry.path ? null : entry.path)}
              >
                <MoreHorizontal size={18} />
              </button>
              {menuPath === entry.path && (
                <div className="file-explorer-menu-items">
                  {entry.type === "file" && (
                    <button type="button" onClick={() => openFile(entry.path)}>
                      <FilePenLine size={15} /> Edit
                    </button>
                  )}
                  <button type="button" onClick={() => { setClipboard({ path: entry.path, action: "copy", name: entry.name }); setMenuPath(null); }}>
                    <Copy size={15} /> Copy
                  </button>
                  <button type="button" onClick={() => { setClipboard({ path: entry.path, action: "move", name: entry.name }); setMenuPath(null); }}>
                    <Scissors size={15} /> Cut
                  </button>
                  <button type="button" onClick={() => renameEntry(entry)}>
                    <FilePenLine size={15} /> Rename
                  </button>
                  <button type="button" className="danger" onClick={() => removeEntry(entry)}>
                    <Trash2 size={15} /> Delete
                  </button>
                </div>
              )}
            </div>
          </article>
          ))}
          </div>
        ) : null}
        {!loading && !error && data && !data.entries.length && <div className="empty-state"><Folder size={22} /><b>This folder is empty</b></div>}
        {!loading && !error && (data?.total || 0) > (data?.limit || 100) && <div className="actions"><Btn disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 100))}>Previous</Btn><small>{offset + 1}–{Math.min(offset + 100, data!.total!)} of {data!.total}</small><Btn disabled={offset + 100 >= data!.total!} onClick={() => setOffset(offset + 100)}>Next</Btn></div>}
      </Panel>
      {editor && (
        <FileEditor
          file={editor}
          close={() => setEditor(null)}
          changed={async () => {
            setEditor(null);
            await load();
          }}
        />
      )}
    </>
  );
}
function FileEditor({
  file,
  close,
  changed,
}: {
  file: { path: string; content: string };
  close: () => void;
  changed: () => void;
}) {
  const [content, setContent] = useState(file.content),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  async function saveFile() {
    try {
      setSaving(true);
      await api("file/save", { path: file.path, content });
      changed();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save file");
    } finally {
      setSaving(false);
    }
  }
  async function deleteFile() {
    if (!await appConfirm(`Delete ${file.path}? This cannot be undone.`, "Delete file", "Delete", true)) return;
    try {
      setSaving(true);
      await api("file/operation", { action: "delete", source: file.path });
      changed();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete file");
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal title="Edit file" close={close}>
      <div className="file-editor">
        <code>{file.path}</code>
        <textarea value={content} onChange={(event) => setContent(event.target.value)} spellCheck={false} />
        {error && <div className="alert">{error}</div>}
        <div className="actions">
          <Btn className="primary" disabled={saving} onClick={saveFile}>
            {saving ? <Loader2 className="spin" size={15} /> : null} Save changes
          </Btn>
          <Btn className="danger" disabled={saving} onClick={deleteFile}><Trash2 size={15} />Delete file</Btn>
        </div>
      </div>
    </Modal>
  );
}
function FileBrowser({ choose }: { choose: (path: string) => void }) {
  const [directory, setDirectory] = useState("");
  const { data, error, loading } = useDirectory<FileBrowserData>("file/browse", directory);
  return (
    <section className="file-browser" aria-label="File browser">
      <div className="file-browser-head">
        <div><b>Choose a file</b><small>{data?.path || "Loading folder…"}</small></div>
        {(data?.roots.length || 0) > 1 && (
          <select className="file-browser-roots" aria-label="Location" value={currentLocation(data, directory)} onChange={(event) => setDirectory(event.target.value)}>
            {data?.roots.map((root) => <option key={root} value={root}>{root}</option>)}
          </select>
        )}
        <Btn type="button" disabled={!data?.parent} onClick={() => data?.parent && setDirectory(data.parent)}><ChevronLeft size={16} />Up</Btn>
      </div>
      <div className="file-browser-list">
        {loading && !error && <div className="file-browser-empty"><Loader2 className="spin" size={18} /> Loading files…</div>}
        {error && <div className="file-browser-empty">{error}</div>}
        {!loading && !error && data?.entries.map((entry) => (
          <button key={entry.path} type="button" className="file-browser-row" onClick={() => entry.type === "directory" ? setDirectory(entry.path) : choose(entry.path)}>
            {entry.type === "directory" ? <Folder size={17} /> : <FileTerminal size={17} />}
            <span>{entry.name}</span><small>{entry.type === "directory" ? "Folder" : "File"}</small>
          </button>
        ))}
        {!loading && !error && data && !data.entries.length && <div className="file-browser-empty">No folders or files here.</div>}
      </div>
    </section>
  );
}
function DirectoryBrowser({ choose }: { choose: (path: string) => void }) {
  const [directory, setDirectory] = useState("");
  const { data, error, loading } = useDirectory<FileBrowserData>("file/browse", directory);
  return (
    <section className="file-browser" aria-label="Folder browser">
      <div className="file-browser-head">
        <div><b>Choose a folder</b><small>{data?.path || "Loading folderâ€¦"}</small></div>
        {(data?.roots.length || 0) > 1 && (
          <select className="file-browser-roots" aria-label="Location" value={currentLocation(data, directory)} onChange={(event) => setDirectory(event.target.value)}>
            {data?.roots.map((root) => <option key={root} value={root}>{root}</option>)}
          </select>
        )}
        <Btn type="button" disabled={!data?.parent} onClick={() => data?.parent && setDirectory(data.parent)}><ChevronLeft size={16} />Up</Btn>
      </div>
      <div className="file-browser-list">
        {loading && !error && <div className="file-browser-empty"><Loader2 className="spin" size={18} /> Loading foldersâ€¦</div>}
        {error && <div className="file-browser-empty">{error}</div>}
        {!loading && !error && data?.entries.filter((entry) => entry.type === "directory").map((entry) => (
          <button key={entry.path} type="button" className="file-browser-row" onClick={() => setDirectory(entry.path)}>
            <Folder size={17} /><span>{entry.name}</span><small>Folder</small>
          </button>
        ))}
      </div>
      <div className="file-browser-footer">
        <small>{data?.path || "Select a folder"}</small>
        <Btn type="button" className="primary" disabled={!data?.path} onClick={() => data?.path && choose(data.path)}>Use this folder</Btn>
      </div>
    </section>
  );
}
function ScriptBrowser({ choose }: { choose: (path: string) => void }) {
  const [directory, setDirectory] = useState(""),
    [selected, setSelected] = useState<string | null>(null);
  const { data, error, loading } = useDirectory<ScriptBrowserData>("script/browse", directory);
  useEffect(() => { setSelected(null); }, [directory]);
  return (
    <section className="file-browser" aria-label="Script file browser">
      <div className="file-browser-head">
        <div>
          <b>Choose a script</b>
          <small>{data?.path || "Loading folder…"}</small>
        </div>
        {(data?.roots.length || 0) > 1 && (
          <select className="file-browser-roots" aria-label="Location" value={currentLocation(data, directory)} onChange={(event) => setDirectory(event.target.value)}>
            {data?.roots.map((root) => <option key={root} value={root}>{root}</option>)}
          </select>
        )}
        <Btn
          type="button"
          disabled={!data?.parent}
          onClick={() => {
            if (data?.parent) {
              setSelected(null);
              setDirectory(data.parent);
            }
          }}
        >
          <ChevronLeft size={16} />
          Up
        </Btn>
      </div>
      <div className="file-browser-list">
        {loading && !error && <div className="file-browser-empty"><Loader2 className="spin" size={18} /> Loading files…</div>}
        {error && <div className="file-browser-empty">{error}</div>}
        {!loading && !error && data?.entries.map((entry) => (
          <button
            key={entry.path}
            type="button"
            className="file-browser-row"
            aria-pressed={entry.type === "script" && selected === entry.path}
            onClick={() => {
              if (entry.type === "directory") {
                setSelected(null);
                setDirectory(entry.path);
              } else setSelected(entry.path);
            }}
          >
            {entry.type === "directory" ? <Folder size={17} /> : <FileTerminal size={17} />}
            <span>{entry.name}</span>
            <small>{entry.type === "directory" ? "Folder" : "Shell script"}</small>
          </button>
        ))}
        {!loading && !error && data && !data.entries.length && <div className="file-browser-empty">No folders or .sh files here.</div>}
      </div>
      <div className="file-browser-footer">
        <small>{selected ? selected : "Select a .sh file to continue."}</small>
        <Btn
          type="button"
          className="primary"
          disabled={!selected}
          onClick={() => selected && choose(selected)}
        >
          Use selected script
        </Btn>
      </div>
    </section>
  );
}
function FolderForm({ close, done }: { close: () => void; done: () => void }) {
  const [error, setError] = useState("");
  return (
    <Modal title="New folder" close={close}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            await api(
              "folder/create",
              Object.fromEntries(new FormData(event.currentTarget)),
            );
            done();
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : "Error");
          }
        }}
      >
        <label>
          Folder name
          <input name="name" autoFocus required maxLength={60} />
        </label>
        {error && <div className="alert">{error}</div>}
        <Btn className="primary">Create folder</Btn>
      </form>
    </Modal>
  );
}
function ScheduleForm({
  initial,
  scripts,
  rootAccess,
  close,
  done,
}: {
  initial: Schedule | null;
  scripts: S[];
  rootAccess: boolean;
  close: () => void;
  done: () => void;
}) {
  const [frequency, setFrequency] = useState(initial ? "custom" : "daily"),
    [targetKind, setTargetKind] = useState<"script" | "command">(
      initial?.command ? "command" : "script",
    ),
    [error, setError] = useState("");
  return (
    <Modal title={initial ? "Edit schedule" : "New schedule"} close={close}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const values = Object.fromEntries(
            new FormData(event.currentTarget),
          ) as Record<string, string>;
          const [hour, minute] = (values.time || "03:00")
            .split(":")
            .map(Number);
          let expression = "",
            label = "";
          if (frequency === "custom") {
            expression = (values.expression || "").trim();
            label = (values.label || "Custom schedule").trim();
          }
          if (frequency === "minutes") {
            expression = `*/${values.interval} * * * *`;
            label = `Every ${values.interval} minutes`;
          }
          if (frequency === "hours") {
            expression = `0 */${values.interval} * * *`;
            label = `Every ${values.interval} hour${values.interval === "1" ? "" : "s"}`;
          }
          if (frequency === "daily") {
            expression = `${minute} ${hour} * * *`;
            label = `Every day at ${values.time}`;
          }
          if (frequency === "weekly") {
            expression = `${minute} ${hour} * * ${values.weekday}`;
            label = `Every ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][Number(values.weekday)]} at ${values.time}`;
          }
          if (frequency === "monthly") {
            expression = `${minute} ${hour} ${values.monthday} * *`;
            label = `Day ${values.monthday} of every month at ${values.time}`;
          }
          try {
            await api("schedule/save", {
              id: values.id,
              scriptId: values.scriptId,
              expression,
              label,
              enabled: initial?.enabled === false ? "false" : "true",
              runAs: values.runAs,
              command: values.command,
            });
            done();
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : "Error");
          }
        }}
      >
        <input type="hidden" name="id" defaultValue={initial?.id} />
        <label>
          Run
          <select value={targetKind} onChange={(event) => setTargetKind(event.target.value as "script" | "command")}>
            <option value="script">An approved script</option>
            <option value="command">A custom command</option>
          </select>
        </label>
        {targetKind === "command" ? (
          <label>
            Custom command
            <input name="command" defaultValue={initial?.command} required maxLength={2000} placeholder="/usr/local/bin/task --option" />
            <small>This one-line command runs through cron as the selected user.</small>
          </label>
        ) : (
          <label>
            Script
            <select name="scriptId" required={targetKind === "script"} defaultValue={initial?.scriptId}>
              {scripts.map((script) => (
                <option key={script.id} value={script.id}>
                  {script.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Run as
          <select name="runAs" defaultValue={initial?.runAs || "user"}>
            <option value="user">SSH user</option>
            <option value="root" disabled={!rootAccess}>
              root{rootAccess ? "" : " (not enabled)"}
            </option>
          </select>
          {!rootAccess && (
            <small>Enable root cron access on the server to use this option.</small>
          )}
        </label>
        <label>
          Frequency
          <select
            value={frequency}
            onChange={(event) => setFrequency(event.target.value)}
          >
            <option value="minutes">Every few minutes</option>
            <option value="hours">Every few hours</option>
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
            <option value="monthly">Every month</option>
            <option value="custom">Custom cron expression</option>
          </select>
        </label>
        {(frequency === "minutes" || frequency === "hours") && (
          <label>
            Interval
            <select name="interval">
              {(frequency === "minutes"
                ? [5, 10, 15, 20, 30]
                : [1, 2, 3, 4, 6, 8, 12]
              ).map((value) => (
                <option key={value} value={value}>
                  Every {value} {frequency}
                </option>
              ))}
            </select>
          </label>
        )}
        {(frequency === "daily" ||
          frequency === "weekly" ||
          frequency === "monthly") && (
          <label>
            Time
            <input name="time" type="time" defaultValue="03:00" required />
          </label>
        )}
        {frequency === "weekly" && (
          <label>
            Day of week
            <select name="weekday">
              {[
                "Sunday",
                "Monday",
                "Tuesday",
                "Wednesday",
                "Thursday",
                "Friday",
                "Saturday",
              ].map((day, index) => (
                <option key={day} value={index}>
                  {day}
                </option>
              ))}
            </select>
          </label>
        )}
        {frequency === "monthly" && (
          <label>
            Day of month
            <select name="monthday">
              {Array.from({ length: 28 }, (_, index) => index + 1).map(
                (day) => (
                  <option key={day}>{day}</option>
                ),
              )}
            </select>
          </label>
        )}
        {frequency === "custom" && (
          <>
            <label>
              Cron expression
              <input
                name="expression"
                required
                defaultValue={initial?.expression}
                placeholder="0 3 * * *"
              />
              <small>Use five cron fields, or @reboot.</small>
            </label>
            <label>
              Description
              <input name="label" maxLength={80} defaultValue={initial?.label} placeholder="Every day at 03:00" />
            </label>
          </>
        )}
        {error && <div className="alert">{error}</div>}
        <Btn className="primary">{initial ? "Save schedule" : "Create schedule"}</Btn>
      </form>
    </Modal>
  );
}
function PasswordForm() {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  return (
    <Panel
      title="Change password"
      note="Update the password used to sign in to this dashboard"
    >
      <form
        className="account-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setMessage("");
          setError("");
          const form = event.currentTarget;
          const values = Object.fromEntries(new FormData(form)) as Record<
            string,
            string
          >;
          if (values.newPassword !== values.confirmPassword) {
            setError("The new passwords do not match.");
            return;
          }
          try {
            await api("account/password", values);
            form.reset();
            setMessage(
              "Password changed. Other signed-in sessions were closed.",
            );
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : "Error");
          }
        }}
      >
        <label>
          Current password
          <input
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
          />
        </label>
        <label>
          New password
          <input
            name="newPassword"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
          />
          <small>Use at least 12 characters.</small>
        </label>
        <label>
          Confirm new password
          <input
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
          />
        </label>
        {error && <div className="alert">{error}</div>}
        {message && <div className="success">{message}</div>}
        <Btn className="primary">Change password</Btn>
      </form>
    </Panel>
  );
}
function Overview({ state, active, stopped, openLogs }: { state: St; active: number; stopped: number; openLogs: (title: string, path: string, body: unknown) => void }) {
  const failed = state.runs.find((run) => run.status === "failed");
  const latestScheduleFailure = state.cronRuns.find((run) => run.status === "failed");
  return <>
    <section className="metrics">
      <Metric label="Containers" value={`${active} running`} note={`${stopped} stopped`} icon={<Container />} />
      <Metric label="CPU usage" value={`${state.stats.cpuUsagePercent.toFixed(1)}%`} note={`${state.stats.cpuCores} logical cores`} icon={<Gauge />} />
      <Metric label="RAM" value={formatPercent(state.stats.memoryUsedBytes, state.stats.memoryTotalBytes)} note={`${formatBytes(state.stats.memoryAvailableBytes)} available`} icon={<Gauge />} />
      <Metric label="System disk" value={`${state.stats.diskUsedPercent}% used`} note={`${formatBytes(state.stats.diskTotalBytes - state.stats.diskUsedBytes)} free`} icon={<HardDrive />} />
    </section>
    <Panel title="Attention needed" note="The most useful things to check first.">
      {stopped > 0 && <div className="schedule-row"><div className="grow"><b>{stopped} stopped container{stopped === 1 ? "" : "s"}</b><small>Open Containers to start, inspect, or review logs.</small></div><span className="badge down">Needs attention</span></div>}
      {failed && <div className="schedule-row"><div className="grow"><b>Latest failed script: {failed.scriptName}</b><small>{new Date(failed.startedAt).toLocaleString()} · exit code {failed.exitCode ?? "unknown"}</small></div><Btn onClick={() => openLogs(`${failed.scriptName} run`, "script/log", { id: failed.scriptId, runId: failed.id })}>View log</Btn></div>}
      {!failed && latestScheduleFailure && <div className="schedule-row"><div className="grow"><b>Latest failed schedule: {latestScheduleFailure.label}</b><small>{new Date(latestScheduleFailure.startedAt).toLocaleString()}</small></div><span className="badge down">Failed</span></div>}
      {!stopped && !failed && !latestScheduleFailure && <div className="empty-state"><Circle size={22}/><b>Everything looks healthy</b><p>No stopped containers or failed recent runs.</p></div>}
    </Panel>
    <Panel title="Next steps" note="Common admin tasks"><div className="schedule-row"><div className="grow"><b>{state.scripts.length} approved scripts</b><small>{state.schedules.filter((item) => item.enabled).length} active schedules · manage runs in Scripts and Schedules.</small></div></div></Panel>
  </>;
}
function DevicePanel({ devices, revoke, createCode }: { devices: St["devices"]; revoke: (id: string) => void; createCode: () => void }) {
  return <Panel title="Authorized browsers" note="Revoke access for an unknown device" extra={<Btn className="primary" onClick={createCode}><KeyRound size={16}/>Generate access code</Btn>}>
    {Object.entries(devices).map(([id, device]) => <div className="device-row" key={id}><div className="grow"><b>{device.name}</b><small>Authorized {device.created}</small></div><Btn className="danger" onClick={() => revoke(id)}><Trash2 size={15}/>Revoke</Btn></div>)}
  </Panel>;
}
function ServerSettings() {
  const [settings, setSettings] = useState<{ sshTarget: string; scriptRoot: string; allowedPaths: string[]; remoteLogs: string; metricsRetentionDays: number } | null>(null);
  const [message, setMessage] = useState(""); const [error, setError] = useState("");
  useEffect(() => { void api("settings/server").then(setSettings).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load server settings")); }, []);
  return <Panel title="Server connection" note="The SSH key and known_hosts stay in Docker mounts; this page stores only the connection and permitted paths.">
    {!settings ? <p>{error || "Loading server settings…"}</p> : <form className="account-form" onSubmit={async (event) => { event.preventDefault(); setMessage(""); setError(""); try { const result = await api("settings/server", Object.fromEntries(new FormData(event.currentTarget))); setSettings(result.settings); setMessage(`Connection verified: ${result.connection.host}.`); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save settings"); } }}>
      <label>SSH target <input name="sshTarget" defaultValue={settings.sshTarget} placeholder="user@server" spellCheck={false} /><small>Leave empty only when the dashboard runs on the server itself.</small></label>
      <label>Script root <input name="scriptRoot" required defaultValue={settings.scriptRoot} spellCheck={false} /></label>
      <label>Allowed paths <input name="allowedPaths" required defaultValue={settings.allowedPaths.join(", ")} spellCheck={false} /><small>Comma-separated absolute paths. File and script access is limited to these locations.</small></label>
      <label>Remote logs folder <input name="remoteLogs" required defaultValue={settings.remoteLogs} spellCheck={false} /></label>
      <label>Metric retention (days) <input name="metricsRetentionDays" type="number" min="1" max="365" required defaultValue={settings.metricsRetentionDays} /><small>Older dashboard health samples are removed during refreshes.</small></label>
      {message && <div className="success">{message}</div>}{error && <div className="alert">{error}</div>}<Btn className="primary">Save and test connection</Btn>
    </form>}
  </Panel>;
}
function HistoryPanel({ runs, cronRuns, metrics, openLog }: { runs: St["runs"]; cronRuns: St["cronRuns"]; metrics: St["metrics"]; openLog: (run: St["runs"][number]) => void }) {
  const latest = metrics.at(-1);
  const [kind, setKind] = useState<"scripts" | "cron">("scripts");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(0);
  const rows = kind === "scripts" ? runs : cronRuns;
  const filtered = rows.filter((row) => {
    const title = kind === "scripts" ? (row as St["runs"][number]).scriptName : (row as St["cronRuns"][number]).label;
    return title.toLowerCase().includes(search.toLowerCase()) && (status === "all" || row.status === status);
  });
  const perPage = 20, pages = Math.max(1, Math.ceil(filtered.length / perPage));
  const visible = filtered.slice(page * perPage, page * perPage + perPage);
  const switchKind = (next: "scripts" | "cron") => { setKind(next); setSearch(""); setStatus("all"); setPage(0); };
  return <>
    <section className="metrics">
      <Metric label="CPU history" value={latest ? `${latest.cpu.toFixed(1)}%` : "No samples"} icon={<Gauge />} />
      <Metric label="RAM history" value={latest ? `${latest.ram.toFixed(1)}%` : "No samples"} icon={<Gauge />} />
      <Metric label="Samples retained" value={String(metrics.length)} note="Retention is configurable on the server" icon={<Clock3 />} />
    </section>
    <Panel title="Execution history" note="Search, filter, and review manual script runs or scheduled cron jobs.">
      <div className="container-filters" aria-label="History type">
        <button type="button" className={kind === "scripts" ? "active" : ""} onClick={() => switchKind("scripts")}>Script runs <span>{runs.length}</span></button>
        <button type="button" className={kind === "cron" ? "active" : ""} onClick={() => switchKind("cron")}>Cron runs <span>{cronRuns.length}</span></button>
      </div>
      <div className="actions" style={{ margin: "16px 0" }}>
        <input aria-label="Search execution history" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} placeholder={kind === "scripts" ? "Search script name or run" : "Search cron schedule"} />
        <select aria-label="Filter status" value={status} onChange={(event) => { setStatus(event.target.value); setPage(0); }}><option value="all">All statuses</option><option value="success">Success</option><option value="failed">Failed</option><option value="running">Running</option></select>
        <small>{filtered.length} result{filtered.length === 1 ? "" : "s"}</small>
      </div>
      {visible.map((row, index) => kind === "scripts" ? (() => { const run = row as St["runs"][number]; return <div className="schedule-row" key={run.id}><div className="grow"><b>{run.scriptName}</b><small>{new Date(run.startedAt).toLocaleString()} · {run.arguments || "no arguments"} · {run.durationMs === undefined ? "in progress" : `${(run.durationMs / 1000).toFixed(1)}s`}</small></div><span className={`badge ${run.status === "success" ? "up" : run.status === "failed" ? "down" : "root"}`}>{run.status}{run.status === "failed" && run.exitCode !== undefined ? ` · code ${run.exitCode}` : ""}</span><Btn onClick={() => openLog(run)}>Log</Btn></div>; })() : (() => { const run = row as St["cronRuns"][number]; return <div className="schedule-row" key={`${run.scheduleId}-${run.startedAt}-${index}`}><div className="grow"><b>{run.label}</b><small>Started {new Date(run.startedAt).toLocaleString()}{run.completedAt ? ` · completed ${new Date(run.completedAt).toLocaleString()}` : ""}</small></div><span className={`badge ${run.status === "success" ? "up" : run.status === "failed" ? "down" : "root"}`}>{run.status}{run.status === "failed" && run.exitCode !== undefined ? ` · code ${run.exitCode}` : ""}</span></div>; })())}
      {!filtered.length && <div className="empty-state"><Clock3 size={22}/><b>{search || status !== "all" ? "No matching runs" : kind === "scripts" ? "No execution history yet" : "No cron runs recorded yet"}</b><p>{kind === "scripts" ? "Runs started from the dashboard will appear here." : "Save or change an existing schedule to enable tracking."}</p></div>}
      {filtered.length > perPage && <div className="actions" style={{ marginTop: 16 }}><Btn disabled={page === 0} onClick={() => setPage((value) => value - 1)}>Previous</Btn><small>Page {page + 1} of {pages}</small><Btn disabled={page + 1 >= pages} onClick={() => setPage((value) => value + 1)}>Next</Btn></div>}
    </Panel>
  </>;
}
function AlertForm({ initial, close, done }: { initial: St["alerts"][number] | null; close: () => void; done: () => void }) {
  const [error, setError] = useState("");
  return <Modal title={initial ? "Edit alert" : "New alert"} close={close}><form onSubmit={async (event) => { event.preventDefault(); try { await api("alerts/save", Object.fromEntries(new FormData(event.currentTarget))); done(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Error"); } }}>
    <input type="hidden" name="id" defaultValue={initial?.id} />
    <label>Name<input name="name" defaultValue={initial?.name} required maxLength={80} /></label>
    <label>Metric<select name="metric" defaultValue={initial?.metric || "temperature"}><option value="temperature">CPU temperature (°C)</option><option value="cpu">CPU use (%)</option><option value="ram">RAM use (%)</option><option value="disk">System disk use (%)</option><option value="failedScripts">Failed script runs</option><option value="stoppedContainers">Stopped containers</option></select></label>
    <label>Trigger at or above<input name="threshold" type="number" min="0" step="0.1" defaultValue={initial?.threshold ?? 80} required /></label>
    <label>Cooldown (minutes)<input name="cooldownMinutes" type="number" min="1" max="10080" defaultValue={initial?.cooldownMinutes ?? 30} required /></label>
    <label><input name="enabled" type="checkbox" value="true" defaultChecked={initial?.enabled !== false} /> Enabled</label>
    {error && <div className="alert">{error}</div>}<Btn className="primary">Save alert</Btn>
  </form></Modal>;
}
function ConfigurationPanel({ refresh }: { refresh: () => Promise<void> }) {
  const [message, setMessage] = useState(""); const [error, setError] = useState("");
  return <Panel title="Dashboard settings backup" note="Exports dashboard scripts, schedules, folders, alerts, and authorized devices. It does not contain server files, Docker data, passwords, SSH keys, or sessions.">
    <div className="actions"><Btn onClick={async () => { const data = await api("config/export"); const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "media-dashboard-settings.json"; link.click(); URL.revokeObjectURL(link.href); setMessage("Settings export downloaded."); }}>Export dashboard settings</Btn>
      <label className="button">Restore dashboard settings<input type="file" accept="application/json" hidden onChange={async (event) => { const file = event.target.files?.[0]; if (!file || !await appConfirm("Restore dashboard settings and overwrite scripts, folders, schedules, devices and alerts?", "Restore dashboard settings", "Restore", true)) return; try { await api("config/restore", { payload: await file.text() }); await refresh(); setMessage("Dashboard settings restored."); } catch (reason) { setError(reason instanceof Error ? reason.message : "Restore failed"); } }} /></label></div>
    {message && <div className="success">{message}</div>}{error && <div className="alert">{error}</div>}
  </Panel>;
}
function StorageManager({ paths, close, done }: { paths: string[]; close: () => void; done: () => Promise<void> }) {
  const [error, setError] = useState(""); const [adding, setAdding] = useState(false);
  return <Modal title="Monitored storage" close={close}>
    <p>Choose the mounted folders whose disk usage should appear on the dashboard. You can track as many paths as needed.</p>
    <form onSubmit={async (event) => { event.preventDefault(); const form = event.currentTarget; setError(""); try { setAdding(true); const path = String(new FormData(form).get("path") || ""); await api("storage/add", { path }); form.reset(); await done(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not add path"); } finally { setAdding(false); } }}>
      <label>Absolute folder path<input name="path" placeholder="/mnt/media" required spellCheck={false} /></label><Btn className="primary" disabled={adding}>Add storage path</Btn>
    </form>
    <div className="storage-path-list">{paths.map((path) => <div className="schedule-row" key={path}><div className="grow"><b>{path}</b><small>Monitored storage path</small></div><Btn className="danger" disabled={paths.length < 2} onClick={async () => { if (!await appConfirm(`Stop monitoring ${path}?`, "Remove storage path", "Remove", true)) return; try { await api("storage/remove", { path }); await done(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not remove path"); } }}><Trash2 size={15}/>Remove</Btn></div>)}</div>
    {error && <div className="alert">{error}</div>}<small>At least one path must remain monitored.</small>
  </Modal>;
}
function AppLoading() {
  return (
    <div className="app-loading" role="status" aria-live="polite">
      <div>
        <Loader2 className="spin" size={22} />
        <span>Working…</span>
      </div>
    </div>
  );
}
function LoadingScreen() {
  return (
    <main className="loading-screen" role="status" aria-live="polite">
      <div>
        <span className="login-logo">
          <img src="/icon.svg" alt="" />
        </span>
        <Loader2 className="spin" size={22} />
        <p>Loading Linux Server Control…</p>
      </div>
    </main>
  );
}
function Login({
  error,
  done,
  loading,
}: {
  error: string;
  done: () => void;
  loading: boolean;
}) {
  const [msg, setMsg] = useState(error);
  return (
    <main className="login-wrap">
      <section className="login-card">
        <div className="login-logo">
          <img src="/icon.svg" alt="" />
        </div>
        <h1>Linux Server Control</h1>
        <p>Secure administration for your media server.</p>
        {msg && <div className="alert">{msg}</div>}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setMsg("");
            try {
              await api(
                "login",
                Object.fromEntries(new FormData(e.currentTarget)),
              );
              done();
            } catch (x) {
              setMsg(x instanceof Error ? x.message : "Error");
            }
          }}
        >
          <label>
            Username
            <input name="username" autoComplete="username" />
          </label>
          <label>
            Password
            <input name="password" type="password" />
          </label>
          <details className="enroll">
            <summary>New browser? Enter an enrollment code</summary>
            <label>
              Code
              <input name="code" />
            </label>
            <label>
              Device name
              <input name="deviceName" />
            </label>
          </details>
          <Btn className="primary full" disabled={loading}>
            {loading && <Loader2 className="spin" size={16} />}
            {loading ? "Signing in…" : "Sign in"}
          </Btn>
        </form>
      </section>
    </main>
  );
}
function ConnectionUnavailable({ error, retry, loading }: { error: string; retry: () => void; loading: boolean }) {
  return <main className="login-wrap"><section className="login-card"><div className="login-logo"><img src="/icon.svg" alt="" /></div><h1>Server unavailable</h1><p>Your dashboard session is still valid, but it cannot reach the managed server over SSH.</p><div className="alert">{error}</div><p>Check that the server is online, then verify the SSH target, key, and known_hosts mount. Once it reconnects, Settings will be available again.</p><Btn className="primary full" disabled={loading} onClick={retry}>{loading ? "Reconnecting…" : "Reconnect"}</Btn></section></main>;
}
function Setup({ done, loading }: { done: () => void; loading: boolean }) {
  const [message, setMessage] = useState("");
  const [server, setServer] = useState<{ sshTarget: string; scriptRoot: string; allowedPaths: string[]; remoteLogs: string } | null>(null);
  useEffect(() => { void api("setup/status", undefined, true).then((data) => setServer(data.server)).catch(() => {}); }, []);
  return (
    <main className="login-wrap">
      <section className="login-card">
        <div className="login-logo"><img src="/icon.svg" alt="" /></div>
        <h1>Set up Linux Server Control</h1>
        <p>Create the administrator account and verify the server connection.</p>
        {message && <div className="alert">{message}</div>}
        <form key={server?.sshTarget || "loading"} onSubmit={async (event) => {
          event.preventDefault();
          try {
            await api("setup", Object.fromEntries(new FormData(event.currentTarget)));
            done();
          } catch (reason) {
            setMessage(reason instanceof Error ? reason.message : "Setup failed");
          }
        }}>
          <label>Setup token<input name="setupToken" required autoComplete="one-time-code" spellCheck={false} /></label>
          <label>Username<input name="username" defaultValue="admin" required maxLength={40} autoComplete="username" /></label>
          <label>Password<input name="password" type="password" minLength={12} required autoComplete="new-password" /></label>
          <label>Confirm password<input name="confirmPassword" type="password" minLength={12} required autoComplete="new-password" /></label>
          <label>Device name<input name="deviceName" defaultValue="First browser" maxLength={80} /></label>
          <label>SSH target<input name="sshTarget" placeholder="user@server" defaultValue={server?.sshTarget || ""} spellCheck={false} /><small>Leave empty only when this container runs directly on the server.</small></label>
          <label>Script root<input name="scriptRoot" defaultValue={server?.scriptRoot || "/home"} required spellCheck={false} /></label>
          <label>Allowed paths<input name="allowedPaths" defaultValue={server?.allowedPaths.join(", ") || "/home"} required spellCheck={false} /><small>Comma-separated absolute paths the dashboard may browse or run scripts from.</small></label>
          <label>Remote logs folder<input name="remoteLogs" defaultValue={server?.remoteLogs || "/tmp/media-dashboard"} required spellCheck={false} /></label>
          <small>Find the token with <code>docker compose logs dashboard</code>. The SSH key and server fingerprint must already be mounted as <code>/run/ssh/id_ed25519</code> and <code>/run/ssh/known_hosts</code>. This browser will be authorized automatically.</small>
          <Btn className="primary full" disabled={loading}>{loading ? "Setting up…" : "Finish setup"}</Btn>
        </form>
      </section>
    </main>
  );
}
