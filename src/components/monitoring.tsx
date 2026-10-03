"use client";
import { ChartFrame, LineChart, RangeFilter, type Range } from "@/components/charts";
import { PowerPage } from "@/components/power";
import { memo, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client-api";
import { Btn, Panel, Metric, formatBytes, formatDuration, formatPercent, Modal, RunBadge } from "@/components/ui";
import type { CronRun, Run, St } from "@/lib/types";
import { language, locale, msg, t, tn } from "@/lib/i18n";
import {
  Circle,
  Clock3,
  Container,
  Gauge,
  HardDrive,
} from "lucide-react";
export function Overview({ state, active, stopped, openLogs }: { state: St; active: number; stopped: number; openLogs: (title: string, path: string, body: unknown) => void }) {
  // What still needs attention, not everything that ever went wrong: a script
  // or schedule is listed while its latest run is a failed one, and an alert
  // rule while its value is at or above its threshold.
  const scripts = new Set(state.scripts.map((script) => script.id));
  const failedRuns = state.recentRuns.filter((run) => run.status === "failed" && scripts.has(run.scriptId));
  const failedSchedules = state.cronFailures ?? [];
  const values = state.alertState?.values ?? {};
  const activeAlerts = state.alerts.filter((rule) => rule.enabled && values[rule.metric] >= rule.threshold);
  const healthy = !stopped && !failedRuns.length && !failedSchedules.length && !activeAlerts.length;
  return <>
    <section className="metrics">
      <Metric label={t("Containers")} value={t("{count} running", { count: active })} note={t("{count} stopped", { count: stopped })} icon={<Container />} />
      <Metric label={t("CPU usage")} value={`${state.stats.cpuUsagePercent.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`} note={tn("{count} logical core|{count} logical cores", state.stats.cpuCores)} icon={<Gauge />} />
      <Metric label={t("RAM")} value={formatPercent(state.stats.memoryUsedBytes, state.stats.memoryTotalBytes)} note={t("{size} available", { size: formatBytes(state.stats.memoryAvailableBytes) })} icon={<Gauge />} />
      <Metric label={t("System disk")} value={t("{percent}% used", { percent: state.stats.diskUsedPercent })} note={t("{size} free", { size: formatBytes(state.stats.diskTotalBytes - state.stats.diskUsedBytes) })} icon={<HardDrive />} />
    </section>
    <Panel title={t("Attention needed")} note={t("The most useful things to check first.")}>
      {stopped > 0 && <div className="schedule-row"><div className="grow"><b>{tn("{count} stopped container|{count} stopped containers", stopped)}</b><small>{t("Open Containers to start, inspect, or review logs.")}</small></div><span className="badge down">{t("Needs attention")}</span></div>}
      {activeAlerts.map((rule) => <div className="schedule-row" key={rule.id}><div className="grow"><b>{t("Alert: {name}", { name: rule.name })}</b><small>{describeAlert(rule.metric, rule.threshold)} · {t("now {value}", { value: alertValue(rule.metric, values[rule.metric]) })}</small></div><span className="badge down">{t("Above threshold")}</span></div>)}
      {failedRuns.map((run) => <div className="schedule-row" key={run.id}><div className="grow"><b>{t("Failed script: {name}", { name: run.scriptName })}</b><small>{new Date(run.startedAt).toLocaleString(locale())} · {t("exit code {code}", { code: run.exitCode ?? t("unknown") })}</small></div><Btn onClick={() => openLogs(t("{name} run", { name: run.scriptName }), "script/log", { id: run.scriptId, runId: run.id })}>{t("View log")}</Btn></div>)}
      {failedSchedules.map((run) => <div className="schedule-row" key={`${run.scheduleId}-${run.startedAt}`}><div className="grow"><b>{t("Failed schedule: {name}", { name: run.label })}</b><small>{new Date(run.startedAt).toLocaleString(locale())} · {t("exit code {code}", { code: run.exitCode ?? t("unknown") })}</small></div><span className="badge down">{t("Failed")}</span></div>)}
      {healthy && <div className="empty-state"><Circle size={22}/><b>{t("Everything looks healthy")}</b><p>{t("No stopped containers, failing runs or alerts above their threshold.")}</p></div>}
    </Panel>
    <OverviewCharts language={language()} />
    <Panel title={t("Next steps")} note={t("Common admin tasks")}><div className="schedule-row"><div className="grow"><b>{tn("{count} approved script|{count} approved scripts", state.scripts.length)}</b><small>{tn("{count} active schedule|{count} active schedules", state.schedules.filter((item) => item.enabled).length)} · {t("manage runs in Scripts and Schedules.")}</small></div></div></Panel>
  </>;
}
// Server health and, once devices exist, power, under one range selector.
// Memoized: the charts load their own data, so the dashboard's refreshes do
// not draw them again; a change of language does.
const OverviewCharts = memo(function OverviewCharts({ language: shown }: { language: string }) {
  const [range, setRange] = useState<Range>("24h");
  return <>
    <RangeFilter value={range} onChange={setRange} />
    <MetricCharts range={range} language={shown} />
    <PowerPage range={range} compact />
  </>;
});
// How each alert metric reads in the rule list.
const ALERT_METRICS: Record<string, [string, string]> = {
  temperature: [msg("CPU temperature"), " °C"],
  cpu: [msg("CPU use"), "%"],
  ram: [msg("RAM use"), "%"],
  disk: [msg("System disk use"), "%"],
  storage: [msg("Use of the fullest monitored storage path"), "%"],
  failedScripts: [msg("Failed script runs in 24 hours"), ""],
  stoppedContainers: [msg("Stopped containers"), ""],
};
export function describeAlert(metric: string, threshold: number) {
  const [label, unit] = ALERT_METRICS[metric] ?? [metric, ""];
  return `${t(label)} ≥ ${threshold.toLocaleString(locale())}${unit}`;
}
const alertValue = (metric: string, value: number) => `${(Math.round(value * 10) / 10).toLocaleString(locale())}${ALERT_METRICS[metric]?.[1] ?? ""}`;
type HistoryPage = { rows: (Run | CronRun)[]; total: number; counts: { scripts: number; cron: number } };
const HISTORY_PAGE_ROWS = 20;
// The run history, a page at a time: searching, filtering and paging happen on
// the server, so the page never holds more than the rows it shows.
export function HistoryPanel({ metrics, openLog }: { metrics: St["metrics"]; openLog: (run: Run) => void }) {
  const latest = metrics?.latest;
  const [kind, setKind] = useState<"scripts" | "cron">("scripts");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<(HistoryPage & { kind: string }) | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    const query = new URLSearchParams({ kind, search, status, offset: String(page * HISTORY_PAGE_ROWS), limit: String(HISTORY_PAGE_ROWS) });
    const load = () => api(`history/runs?${query}`, undefined, true)
      .then((result: HistoryPage) => { if (current) { setData({ ...result, kind }); setError(""); } })
      .catch((reason) => { if (current) setError(reason instanceof Error ? reason.message : t("Could not load the history")); });
    // Typing in the search field waits a moment instead of asking per letter.
    const first = setTimeout(load, search ? 250 : 0);
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 15000);
    return () => { current = false; clearTimeout(first); clearInterval(timer); };
  }, [kind, search, status, page]);
  // Rows of the other tab are not shown while this tab's first page loads.
  const rows = data?.kind === kind ? data.rows : [];
  const loading = data?.kind !== kind;
  const total = loading ? 0 : data!.total;
  const pages = Math.max(1, Math.ceil(total / HISTORY_PAGE_ROWS));
  const switchKind = (next: "scripts" | "cron") => { setKind(next); setSearch(""); setStatus("all"); setPage(0); };
  const badge = (run: Run | CronRun) => <RunBadge run={run} />;
  return <>
    <section className="metrics">
      <Metric label={t("CPU history")} value={latest ? `${latest.cpu.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%` : t("No samples")} icon={<Gauge />} />
      <Metric label={t("RAM history")} value={latest ? `${latest.ram.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%` : t("No samples")} icon={<Gauge />} />
      <Metric label={t("Samples retained")} value={(metrics?.count ?? 0).toLocaleString(locale())} note={tn("One sample every minute|One sample every {count} minutes", metrics?.intervalMinutes ?? 5)} icon={<Clock3 />} />
    </section>
    <Panel title={t("Execution history")} note={t("Search, filter, and review manual script runs or scheduled cron jobs.")}>
      <div className="panel-toolbar history-toolbar">
        <div className="container-filters" aria-label={t("History type")}>
          <button type="button" className={kind === "scripts" ? "active" : ""} onClick={() => switchKind("scripts")}>{t("Script runs")} <span>{data?.counts.scripts ?? "…"}</span></button>
          <button type="button" className={kind === "cron" ? "active" : ""} onClick={() => switchKind("cron")}>{t("Cron runs")} <span>{data?.counts.cron ?? "…"}</span></button>
        </div>
        <div className="history-fields">
          <input aria-label={t("Search execution history")} value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} placeholder={kind === "scripts" ? t("Search script name or run") : t("Search script or schedule")} />
          <select aria-label={t("Filter status")} value={status} onChange={(event) => { setStatus(event.target.value); setPage(0); }}><option value="all">{t("All statuses")}</option><option value="success">{t("Success")}</option><option value="failed">{t("Failed")}</option><option value="running">{t("Running")}</option>{kind === "scripts" && <option value="stopped">{t("Stopped")}</option>}</select>
        </div>
        <small>{loading ? t("Loading…") : tn("{count} result|{count} results", total)}</small>
      </div>
      {error && <div className="panel-body"><div className="alert">{error}</div></div>}
      {rows.map((row, index) => kind === "scripts"
        ? (() => { const run = row as Run; return <div className="schedule-row" key={run.id}><div className="grow"><b>{run.scriptName}</b><small>{new Date(run.startedAt).toLocaleString(locale())} · {run.arguments || t("no arguments")} · {run.durationMs === undefined ? t("in progress") : formatDuration(run.durationMs)}{run.stoppedBy ? ` · ${t("stopped by {name}", { name: run.stoppedBy })}` : ""}</small></div>{badge(run)}<Btn onClick={() => openLog(run)}>{t("Log")}</Btn></div>; })()
        : (() => { const run = row as CronRun; return <div className="schedule-row" key={`${run.scheduleId}-${run.startedAt}-${index}`}><div className="grow"><b>{run.name || run.label}</b><small>{run.name && run.name !== run.label ? `${run.label} · ` : ""}{t("Started {time}", { time: new Date(run.startedAt).toLocaleString(locale()) })}{run.completedAt ? ` · ${t("completed {time}", { time: new Date(run.completedAt).toLocaleString(locale()) })}` : ""}</small></div>{badge(run)}</div>; })())}
      {!loading && !total && !error && <div className="empty-state"><Clock3 size={22}/><b>{search || status !== "all" ? t("No matching runs") : kind === "scripts" ? t("No execution history yet") : t("No cron runs recorded yet")}</b><p>{kind === "scripts" ? t("Runs started from the dashboard will appear here.") : t("Save or change an existing schedule to enable tracking.")}</p></div>}
      {total > HISTORY_PAGE_ROWS && <div className="actions panel-pagination"><Btn disabled={page === 0} onClick={() => setPage((value) => value - 1)}>{t("Previous")}</Btn><small>{t("Page {page} of {pages}", { page: Math.min(page, pages - 1) + 1, pages })}</small><Btn disabled={page + 1 >= pages} onClick={() => setPage((value) => value + 1)}>{t("Next")}</Btn></div>}
    </Panel>
  </>;
}
export function AlertForm({ initial, close, done }: { initial: St["alerts"][number] | null; close: () => void; done: () => void }) {
  const [error, setError] = useState("");
  return <Modal title={initial ? t("Edit alert") : t("New alert")} close={close}><form onSubmit={async (event) => { event.preventDefault(); try { await api("alerts/save", Object.fromEntries(new FormData(event.currentTarget))); done(); } catch (reason) { setError(reason instanceof Error ? reason.message : t("Error")); } }}>
    <input type="hidden" name="id" defaultValue={initial?.id} />
    <label>{t("Name")}<input name="name" defaultValue={initial?.name} required maxLength={80} /></label>
    <label>{t("Metric")}<select name="metric" defaultValue={initial?.metric || "temperature"}><option value="temperature">{t("CPU temperature (°C)")}</option><option value="cpu">{t("CPU use (%)")}</option><option value="ram">{t("RAM use (%)")}</option><option value="disk">{t("System disk use (%)")}</option><option value="storage">{t("Monitored storage use, fullest path (%)")}</option><option value="failedScripts">{t("Failed script runs (last 24 hours)")}</option><option value="stoppedContainers">{t("Stopped containers")}</option></select></label>
    <label>{t("Trigger at or above")}<input name="threshold" type="number" min="0" step="0.1" defaultValue={initial?.threshold ?? 80} required /></label>
    <label>{t("Cooldown (minutes)")}<input name="cooldownMinutes" type="number" min="1" max="10080" defaultValue={initial?.cooldownMinutes ?? 30} required /></label>
    <label><input name="enabled" type="checkbox" value="true" defaultChecked={initial?.enabled !== false} /> {t("Enabled")}</label>
    {error && <div className="alert">{error}</div>}<Btn className="primary">{t("Save alert")}</Btn>
  </form></Modal>;
}

type History = { from: number; to: number; samples: { at: number; cpu: number | null; ram: number | null; temperature: number | null; disk: number | null; storage: Record<string, number | null> }[] };
// Server health over time from the samples recorded every 5 minutes.
// With a range from the caller the charts follow it; otherwise they show
// their own range selector.
// How often open charts ask for new samples; the server records one every 5 minutes.
const CHART_REFRESH_MS = 5 * 60 * 1000;
const round = (value: number | null) => (value === null ? "—" : value.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
export function MetricCharts({ range: controlled, language: shown = language() }: { range?: Range; language?: string } = {}) {
  const [own, setRange] = useState<Range>("24h");
  const range = controlled ?? own;
  const [history, setHistory] = useState<History | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    const load = () => api(`history/metrics?range=${range}`, undefined, true)
      .then((data: History) => { if (current) { setHistory(data); setError(""); } })
      .catch((reason) => { if (current) setError(reason instanceof Error ? reason.message : t("Could not load metrics")); });
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, CHART_REFRESH_MS);
    return () => { current = false; clearInterval(timer); };
  }, [range]);
  // Built once per response, so the charts keep their drawn paths while only
  // the pointer moves, and the tables are only built when they are shown.
  const charts = useMemo(() => {
    const samples = history?.samples || [];
    const sampleTime = new Intl.DateTimeFormat(locale(), { dateStyle: "short", timeStyle: "short" });
    const when = (at: number) => sampleTime.format(at);
    // "/" is the system disk, which already has its own series.
    const paths = [...new Set(samples.flatMap((sample) => Object.keys(sample.storage || {})))].filter((path) => path !== "/");
    const storage = [{ id: "disk", label: t("System disk"), values: samples.map((sample) => sample.disk) }, ...paths.map((path) => ({ id: path, label: path, values: samples.map((sample) => sample.storage?.[path] ?? null) }))].slice(0, 8);
    return {
      times: samples.map((sample) => sample.at),
      load: [{ id: "cpu", label: t("CPU"), values: samples.map((sample) => sample.cpu) }, { id: "ram", label: t("RAM"), values: samples.map((sample) => sample.ram) }],
      temperature: [{ id: "temperature", label: t("Temperature"), values: samples.map((sample) => sample.temperature) }],
      storage,
      loadRows: () => samples.map((sample) => [when(sample.at), round(sample.cpu), round(sample.ram)]),
      temperatureRows: () => samples.map((sample) => [when(sample.at), round(sample.temperature)]),
      storageRows: () => samples.map((sample, index) => [when(sample.at), ...storage.map((item) => round(item.values[index]))]),
    };
    // The labels are in the chosen language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, shown]);
  return <>
    {!controlled && <RangeFilter value={range} onChange={setRange} />}
    {error && <div className="alert">{error}</div>}
    <div className="chart-grid-2" style={{ opacity: history ? 1 : 0.6 }}>
      <ChartFrame title={t("CPU and RAM")} note={t("Average use, percent")} table={{ columns: [t("Time"), t("CPU %"), t("RAM %")], rows: charts.loadRows }}>
        <LineChart times={charts.times} unit="%" yMax={100} series={charts.load} />
      </ChartFrame>
      <ChartFrame title={t("Temperature")} note={t("Hottest sensor, °C")} table={{ columns: [t("Time"), "°C"], rows: charts.temperatureRows }}>
        <LineChart times={charts.times} unit="°C" series={charts.temperature} empty={t("No temperature sensor data in this range.")} />
      </ChartFrame>
    </div>
    <ChartFrame title={t("Storage used")} note={t("Percent of capacity per monitored path")} table={{ columns: [t("Time"), ...charts.storage.map((item) => `${item.label} %`)], rows: charts.storageRows }}>
      <LineChart times={charts.times} unit="%" yMax={100} series={charts.storage} />
    </ChartFrame>
  </>;
}
