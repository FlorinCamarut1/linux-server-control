"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
async function api(path: string, body?: unknown, silent = false) {
  if (!silent && typeof window !== "undefined")
    window.dispatchEvent(new Event("media-control-request-start"));
  try {
    const r = await fetch(`/api/${path}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const d = await r.json();
    if (!r.ok) throw Error(d.error || "Request failed");
    return d;
  } finally {
    if (!silent && typeof window !== "undefined")
      window.dispatchEvent(new Event("media-control-request-end"));
  }
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
    [tab, setTab] = useState("containers"),
    [containerFilter, setContainerFilter] = useState<
      "all" | "running" | "stopped"
    >("all"),
    [logs, setLogs] = useState<{ title: string; path: string; request: unknown } | null>(null),
    [edit, setEdit] = useState<S | null | undefined>(),
    [customScriptEditor, setCustomScriptEditor] = useState(false),
    [runPrompt, setRunPrompt] = useState<S | null>(null),
    [scheduleEditor, setScheduleEditor] = useState<Schedule | null | undefined>(),
    [folderEditor, setFolderEditor] = useState(false),
    [enrollment, setEnrollment] = useState<{
      code: string;
      expires: number;
    } | null>(null),
    [copied, setCopied] = useState(false),
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
      setState(null);
      setErr(e instanceof Error ? e.message : "Error");
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
      await api("script/run", { id: script.id });
      setLogs({
        title: `${script.name} logs`,
        path: "script/log",
        request: { id: script.id },
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
  if (!state)
    return <Login error={err} done={refresh} loading={pendingRequests > 0} />;
  const nav = [
    ["containers", Container, "Containers"],
    ["scripts", FileTerminal, "Scripts"],
    ["files", FolderOpen, "Files"],
    ["cron", Clock3, "Schedules"],
    ["devices", Box, "Devices"],
    ["account", KeyRound, "Account"],
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
                  containers: "Containers",
                  scripts: "Scripts",
                  cron: "Schedules",
                  devices: "Devices",
                  account: "Account",
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
              {state.stats.storage.map((drive) => (
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
                        <Btn onClick={() => setEdit(s)}>Edit</Btn>
                        <Btn
                          className="danger"
                          disabled={!!busy}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Delete “${s.name}” and its scheduled jobs?`,
                              )
                            )
                              action(s.id, "script/delete", { id: s.id });
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
        {tab === "devices" && (
          <Panel
            title="Authorized browsers"
            note="Revoke access for an unknown device"
            extra={
              <Btn
                className="primary"
                onClick={async () => {
                  try {
                    setEnrollment(await api("enrollment/create", { minutes: "15" }));
                    setCopied(false);
                  } catch (e) {
                    setErr(e instanceof Error ? e.message : "Error");
                  }
                }}
              >
                <KeyRound size={16} />
                Generate access code
              </Btn>
            }
          >
            {Object.entries(state.devices).map(([id, d]) => (
              <div className="device-row" key={id}>
                <div className="grow">
                  <b>{d.name}</b>
                  <small>Authorized {d.created}</small>
                </div>
                <Btn
                  className="danger"
                  onClick={() => action(id, "device/revoke", { id })}
                >
                  <Trash2 size={15} />
                  Revoke
                </Btn>
              </div>
            ))}
          </Panel>
        )}
        {tab === "account" && <PasswordForm />}
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
          done={async (script) => {
            setRunPrompt(null);
            setLogs({
              title: `${script.name} logs`,
              path: "script/log",
              request: { id: script.id },
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
  done: (script: S) => void;
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
            await api("script/run", { id: script.id, option: selected, file: selectedFile });
            done(script);
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
function useDirectory<T>(endpoint: string, directory: string, includeSizes = false) {
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
      const result = await api(endpoint, { path: directory }, true);
      if (current !== generation.current) return;
      setData(result);
      setLoading(false);
      if (includeSizes && result.entries.some((entry: FileBrowserData["entries"][number]) => entry.type === "directory")) {
        setSizesLoading(true);
        try {
          const measured = await api("file/sizes", { path: result.path }, true);
          if (current === generation.current) setData({
            ...result,
            entries: result.entries.map((entry: FileBrowserData["entries"][number]) =>
              entry.type === "directory" ? { ...entry, size: measured.sizes[entry.path] ?? null } : entry),
          });
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
  }, [endpoint, directory, includeSizes]);
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
    [clipboard, setClipboard] = useState<{
      path: string;
      action: "copy" | "move";
      name: string;
    } | null>(null);
  const { data, error, setError, loading, sizesLoading, load } = useDirectory<FileBrowserData>("file/browse", directory, true);
  function navigate(path: string) {
    setMenuPath(null);
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
    if (window.confirm(description)) await operate("delete", entry.path);
  }
  async function renameEntry(entry: FileBrowserData["entries"][number]) {
    const name = window.prompt(`Rename ${entry.name} to:`, entry.name)?.trim();
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
    if (!window.confirm(`Delete ${file.path}? This cannot be undone.`)) return;
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
            <input name="username" defaultValue="admin" />
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
