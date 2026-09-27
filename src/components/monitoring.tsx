"use client";
import { ChartFrame, LineChart } from "@/components/charts";
import { useEffect, useState } from "react";
import { api } from "@/lib/client-api";
import { Btn, Panel, Metric, formatBytes, formatPercent, Modal } from "@/components/ui";
import type { St } from "@/lib/types";
import {
  Circle,
  Clock3,
  Container,
  Gauge,
  HardDrive,
} from "lucide-react";
export function Overview({ state, active, stopped, openLogs }: { state: St; active: number; stopped: number; openLogs: (title: string, path: string, body: unknown) => void }) {
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
export function HistoryPanel({ runs, cronRuns, metrics, openLog }: { runs: St["runs"]; cronRuns: St["cronRuns"]; metrics: St["metrics"]; openLog: (run: St["runs"][number]) => void }) {
  const latest = metrics?.latest;
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
      <Metric label="Samples retained" value={String(metrics?.count ?? 0)} note={`One sample every ${metrics?.intervalMinutes ?? 5} minutes`} icon={<Clock3 />} />
    </section>
    <MetricCharts />
    <Panel title="Execution history" note="Search, filter, and review manual script runs or scheduled cron jobs.">
      <div className="panel-toolbar history-toolbar">
        <div className="container-filters" aria-label="History type">
          <button type="button" className={kind === "scripts" ? "active" : ""} onClick={() => switchKind("scripts")}>Script runs <span>{runs.length}</span></button>
          <button type="button" className={kind === "cron" ? "active" : ""} onClick={() => switchKind("cron")}>Cron runs <span>{cronRuns.length}</span></button>
        </div>
        <div className="history-fields">
          <input aria-label="Search execution history" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} placeholder={kind === "scripts" ? "Search script name or run" : "Search cron schedule"} />
          <select aria-label="Filter status" value={status} onChange={(event) => { setStatus(event.target.value); setPage(0); }}><option value="all">All statuses</option><option value="success">Success</option><option value="failed">Failed</option><option value="running">Running</option></select>
        </div>
        <small>{filtered.length} result{filtered.length === 1 ? "" : "s"}</small>
      </div>
      {visible.map((row, index) => kind === "scripts" ? (() => { const run = row as St["runs"][number]; return <div className="schedule-row" key={run.id}><div className="grow"><b>{run.scriptName}</b><small>{new Date(run.startedAt).toLocaleString()} · {run.arguments || "no arguments"} · {run.durationMs === undefined ? "in progress" : `${(run.durationMs / 1000).toFixed(1)}s`}</small></div><span className={`badge ${run.status === "success" ? "up" : run.status === "failed" ? "down" : "root"}`}>{run.status}{run.status === "failed" && run.exitCode !== undefined ? ` · code ${run.exitCode}` : ""}</span><Btn onClick={() => openLog(run)}>Log</Btn></div>; })() : (() => { const run = row as St["cronRuns"][number]; return <div className="schedule-row" key={`${run.scheduleId}-${run.startedAt}-${index}`}><div className="grow"><b>{run.label}</b><small>Started {new Date(run.startedAt).toLocaleString()}{run.completedAt ? ` · completed ${new Date(run.completedAt).toLocaleString()}` : ""}</small></div><span className={`badge ${run.status === "success" ? "up" : run.status === "failed" ? "down" : "root"}`}>{run.status}{run.status === "failed" && run.exitCode !== undefined ? ` · code ${run.exitCode}` : ""}</span></div>; })())}
      {!filtered.length && <div className="empty-state"><Clock3 size={22}/><b>{search || status !== "all" ? "No matching runs" : kind === "scripts" ? "No execution history yet" : "No cron runs recorded yet"}</b><p>{kind === "scripts" ? "Runs started from the dashboard will appear here." : "Save or change an existing schedule to enable tracking."}</p></div>}
      {filtered.length > perPage && <div className="actions panel-pagination"><Btn disabled={page === 0} onClick={() => setPage((value) => value - 1)}>Previous</Btn><small>Page {page + 1} of {pages}</small><Btn disabled={page + 1 >= pages} onClick={() => setPage((value) => value + 1)}>Next</Btn></div>}
    </Panel>
  </>;
}
export function AlertForm({ initial, close, done }: { initial: St["alerts"][number] | null; close: () => void; done: () => void }) {
  const [error, setError] = useState("");
  return <Modal title={initial ? "Edit alert" : "New alert"} close={close}><form onSubmit={async (event) => { event.preventDefault(); try { await api("alerts/save", Object.fromEntries(new FormData(event.currentTarget))); done(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Error"); } }}>
    <input type="hidden" name="id" defaultValue={initial?.id} />
    <label>Name<input name="name" defaultValue={initial?.name} required maxLength={80} /></label>
    <label>Metric<select name="metric" defaultValue={initial?.metric || "temperature"}><option value="temperature">CPU temperature (°C)</option><option value="cpu">CPU use (%)</option><option value="ram">RAM use (%)</option><option value="disk">System disk use (%)</option><option value="failedScripts">Failed script runs (last 24 hours)</option><option value="stoppedContainers">Stopped containers</option></select></label>
    <label>Trigger at or above<input name="threshold" type="number" min="0" step="0.1" defaultValue={initial?.threshold ?? 80} required /></label>
    <label>Cooldown (minutes)<input name="cooldownMinutes" type="number" min="1" max="10080" defaultValue={initial?.cooldownMinutes ?? 30} required /></label>
    <label><input name="enabled" type="checkbox" value="true" defaultChecked={initial?.enabled !== false} /> Enabled</label>
    {error && <div className="alert">{error}</div>}<Btn className="primary">Save alert</Btn>
  </form></Modal>;
}

const RANGES = [["24h", "Last 24 hours"], ["7d", "Last 7 days"], ["30d", "Last 30 days"]] as const;
type History = { from: number; to: number; samples: { at: number; cpu: number | null; ram: number | null; temperature: number | null; disk: number | null; storage: Record<string, number | null> }[] };
export function RangeFilter({ value, onChange }: { value: string; onChange: (value: "24h" | "7d" | "30d") => void }) {
  return <div className="chart-filters">
    <div className="container-filters" role="radiogroup" aria-label="Time range">
      {RANGES.map(([id, label]) => <button key={id} type="button" role="radio" aria-checked={value === id} className={value === id ? "active" : ""} title={label} onClick={() => onChange(id)}>{label}</button>)}
    </div>
  </div>;
}
// Server health over time from the samples recorded every 5 minutes.
export function MetricCharts() {
  const [range, setRange] = useState<"24h" | "7d" | "30d">("24h");
  const [history, setHistory] = useState<History | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    api(`history/metrics?range=${range}`, undefined, true)
      .then((data: History) => { if (current) { setHistory(data); setError(""); } })
      .catch((reason) => { if (current) setError(reason instanceof Error ? reason.message : "Could not load metrics"); });
    return () => { current = false; };
  }, [range]);
  const samples = history?.samples || [];
  const times = samples.map((sample) => sample.at);
  const when = (at: number) => new Date(at).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
  const round = (value: number | null) => (value === null ? "—" : value.toFixed(1));
  // "/" is the system disk, which already has its own series.
  const paths = [...new Set(samples.flatMap((sample) => Object.keys(sample.storage || {})))].filter((path) => path !== "/");
  const storageSeries = [{ id: "disk", label: "System disk", values: samples.map((sample) => sample.disk) }, ...paths.map((path) => ({ id: path, label: path, values: samples.map((sample) => sample.storage?.[path] ?? null) }))].slice(0, 8);
  return <>
    <RangeFilter value={range} onChange={setRange} />
    {error && <div className="alert">{error}</div>}
    <div className="chart-grid-2" style={{ opacity: history ? 1 : 0.6 }}>
      <ChartFrame title="CPU and RAM" note="Average use, percent" table={{ columns: ["Time", "CPU %", "RAM %"], rows: samples.map((sample) => [when(sample.at), round(sample.cpu), round(sample.ram)]) }}>
        <LineChart times={times} unit="%" yMax={100} series={[{ id: "cpu", label: "CPU", values: samples.map((sample) => sample.cpu) }, { id: "ram", label: "RAM", values: samples.map((sample) => sample.ram) }]} />
      </ChartFrame>
      <ChartFrame title="Temperature" note="Hottest sensor, °C" table={{ columns: ["Time", "°C"], rows: samples.map((sample) => [when(sample.at), round(sample.temperature)]) }}>
        <LineChart times={times} unit="°C" series={[{ id: "temperature", label: "Temperature", values: samples.map((sample) => sample.temperature) }]} empty="No temperature sensor data in this range." />
      </ChartFrame>
    </div>
    <ChartFrame title="Storage used" note="Percent of capacity per monitored path" table={{ columns: ["Time", ...storageSeries.map((item) => `${item.label} %`)], rows: samples.map((sample, index) => [when(sample.at), ...storageSeries.map((item) => round(item.values[index]))]) }}>
      <LineChart times={times} unit="%" yMax={100} series={storageSeries} />
    </ChartFrame>
  </>;
}
