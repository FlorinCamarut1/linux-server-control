"use client";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/client-api";
import type { PreflightCheck, Run } from "@/lib/types";
import { locale, msg, t } from "@/lib/i18n";
import {
  Check,
  CircleAlert,
  Loader2,
  MoreHorizontal,
  Pause,
  Play,
  Square,
  X,
} from "lucide-react";
export type DialogRequest = {
  kind: "confirm" | "prompt";
  title: string;
  message: string;
  confirmLabel: string;
  defaultValue?: string;
  danger?: boolean;
  resolve: (value: boolean | string | null) => void;
};
export function requestDialog(request: Omit<DialogRequest, "resolve">) {
  return new Promise<boolean | string | null>((resolve) =>
    window.dispatchEvent(new CustomEvent("media-control-dialog", { detail: { ...request, resolve } })),
  );
}
export async function appConfirm(message: string, title = t("Confirm action"), confirmLabel = t("Confirm"), danger = false) {
  return (await requestDialog({ kind: "confirm", title, message, confirmLabel, danger })) === true;
}
export async function appPrompt(message: string, defaultValue = "", title = t("Enter a value"), confirmLabel = t("Continue")) {
  const result = await requestDialog({ kind: "prompt", title, message, confirmLabel, defaultValue });
  return typeof result === "string" ? result : null;
}
// A translated text with elements in it: rich(translated, { command: <code>…</code> }), where
// the translated text holds {command}.
export function rich(text: string, parts: Record<string, React.ReactNode>) {
  return text.split(/\{(\w+)\}/).map((piece, index) => index % 2 ? <span key={index}>{parts[piece] ?? `{${piece}}`}</span> : piece);
}
export const Btn = ({
  className = "",
  ...p
}: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button className={`button ${className}`} {...p} />
);
// What happened after an action, shown at the bottom of the screen where it is
// seen wherever the page is scrolled: successes go by themselves, errors stay
// until they are dismissed.
// Sent by the page's Refresh button, for pages that load their own data.
export const PAGE_REFRESH = "media-control-page-refresh";
type Toast = { id: number; message: string; tone: "error" | "success" };
const TOAST_EVENT = "media-control-toast";
export function notify(message: string, tone: Toast["tone"] = "error") {
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: { message, tone } }));
}
export function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => {
    let next = 0;
    const timers = new Set<number>();
    const add = (event: Event) => {
      const { message, tone } = (event as CustomEvent<Omit<Toast, "id">>).detail;
      const id = ++next;
      // The same message again replaces the earlier one; at most three are shown.
      setToasts((list) => [...list.filter((item) => item.message !== message), { id, message, tone }].slice(-3));
      if (tone === "success") {
        const timer = window.setTimeout(() => {
          timers.delete(timer);
          setToasts((list) => list.filter((item) => item.id !== id));
        }, 4000);
        timers.add(timer);
      }
    };
    window.addEventListener(TOAST_EVENT, add);
    return () => {
      window.removeEventListener(TOAST_EVENT, add);
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
          {toast.tone === "error" ? <CircleAlert size={18} /> : <Check size={18} />}
          <span>{toast.message}</span>
          <button type="button" className="toast-close" aria-label={t("Dismiss")} onClick={() => setToasts((list) => list.filter((item) => item.id !== toast.id))}>
            <X size={18} />
          </button>
        </div>
      ))}
    </div>
  );
}
export function Panel({
  id,
  title,
  note,
  extra,
  children,
}: {
  id?: string;
  title: string;
  note: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="panel" id={id}>
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
// percent: how full something is, drawn as a bar that turns red from 85%.
export function Metric({
  label,
  value,
  note,
  icon,
  percent,
}: {
  label: string;
  value: string;
  note?: string;
  icon: React.ReactNode;
  percent?: number | null;
}) {
  return (
    <div className="metric">
      <span>{icon}</span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
        {note && <em>{note}</em>}
        {typeof percent === "number" && (
          <span className={`metric-bar${percent >= 85 ? " high" : ""}`} aria-hidden="true">
            <i style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
          </span>
        )}
      </div>
    </div>
  );
}
export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const digits = index > 1 ? 1 : 0;
  return `${(bytes / 1024 ** index).toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${units[index]}`;
}
export function formatPercent(used: number, total: number) {
  return total > 0 ? t("{percent}% used", { percent: Math.round((used / total) * 100) }) : t("Unavailable");
}
export function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return t("{days} d {hours} h", { days, hours });
  if (hours) return t("{hours} h {minutes} min", { hours, minutes });
  return t("{minutes} min", { minutes });
}
// navigator.clipboard only exists in secure contexts (HTTPS or localhost). The
// dashboard is normally served over plain HTTP on the LAN, so fall back to
// copying a temporary selection with the legacy copy command.
export async function copyText(text: string) {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
  }
}
// Open dialogs, the innermost last: Escape and the Back button close only the
// one on top.
type OpenModal = { key: string; close: () => void };
const openModals: OpenModal[] = [];
// Each dialog adds an entry to the browser history, so that the Back button or
// gesture of a phone closes the dialog instead of leaving the dashboard. An
// entry lists the dialogs open at that point. The list of the current entry is
// kept here as well, because the browser takes the steps back asked of it
// later: two dialogs that close one after the other (a confirmation, then the
// editor that asked for it) must step back over both entries, not over one
// twice. One step back is taken at a time, and a dialog that opens meanwhile
// adds its entry once it is over.
let entries: string[] | null = null;
let travelling = false, owedSteps = 0;
const waiting: (() => void)[] = [];
const currentEntries = (): string[] => (entries ??= [...(window.history.state?.lscModals ?? [])]);
function addEntry(key: string) {
  if (travelling) return void waiting.push(() => addEntry(key));
  if (currentEntries().at(-1) === key) return;
  entries = [...currentEntries(), key];
  window.history.pushState({ ...window.history.state, lscModals: entries }, "");
}
let settleTimer = 0;
function stepBack(steps: number) {
  if (travelling) return void (owedSteps += steps);
  travelling = true;
  // A step back that the browser does not take (no entry left) sends no event.
  settleTimer = window.setTimeout(arrived, 1000);
  window.history.go(-steps);
}
function arrived() {
  window.clearTimeout(settleTimer);
  travelling = false;
  if (owedSteps) {
    const steps = owedSteps;
    owedSteps = 0;
    return stepBack(steps);
  }
  waiting.splice(0).forEach((add) => add());
}
function historyMoved() {
  if (travelling) return arrived();
  // Back or Forward from the browser: the top dialog closes, as with Escape.
  // Its entry is put back first, so that a dialog that asks before discarding
  // what was typed, and stays open, still has one.
  entries = [...(window.history.state?.lscModals ?? [])];
  const top = openModals.at(-1);
  if (!top || entries.includes(top.key)) return;
  entries = [...entries, top.key];
  window.history.pushState({ ...window.history.state, lscModals: entries }, "");
  top.close();
}
let listening = false, dropping = false;
// Removes the entries of dialogs that closed, once all that close together have.
function dropClosedEntries() {
  if (dropping) return;
  dropping = true;
  queueMicrotask(() => {
    dropping = false;
    const keys = currentEntries(), open = new Set(openModals.map((modal) => modal.key));
    let closed = 0;
    while (closed < keys.length && !open.has(keys[keys.length - 1 - closed])) closed++;
    if (!closed) return;
    entries = keys.slice(0, keys.length - closed);
    stepBack(closed);
  });
}
let modalCount = 0;
const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';
// guard: the dialog is a form; once something was typed or chosen in it,
// closing it by Escape, Back, Close or a press beside it asks first.
export function Modal({
  title,
  close,
  guard = false,
  children,
}: {
  title: string;
  close: () => void;
  guard?: boolean;
  children: React.ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  const titleId = useId();
  // Unique for each dialog opened, unlike useId, which a dialog opened again in
  // the same place would share with the one before it.
  const [key] = useState(() => `modal-${++modalCount}`);
  const edited = useRef(false);
  // The caller's latest close handler, read when Escape or Back is pressed.
  const latestClose = useRef(close);
  useEffect(() => { latestClose.current = close; });
  const requestClose = useCallback(async () => {
    if (guard && edited.current && !await appConfirm(t("Close this form? What you entered is discarded."), t("Unsaved changes"), t("Discard"), true)) return;
    latestClose.current();
  }, [guard]);
  const latestRequest = useRef(requestClose);
  useEffect(() => { latestRequest.current = requestClose; });
  useEffect(() => {
    const entry: OpenModal = { key, close: () => void latestRequest.current() };
    openModals.push(entry);
    if (!listening) {
      window.addEventListener("popstate", historyMoved);
      listening = true;
    }
    addEntry(key);
    const opener = document.activeElement as HTMLElement | null;
    // The dialog takes the focus, unless one of its fields already has it.
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (openModals.at(-1) !== entry || !panel.current) return;
      if (event.key === "Escape") return entry.close();
      if (event.key !== "Tab") return;
      // The focus stays in the dialog: Tab from its last control goes to its first.
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => item.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1], active = document.activeElement;
      const outside = !panel.current.contains(active) || active === panel.current;
      if (event.shiftKey ? outside || active === first : outside || active === last) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      openModals.splice(openModals.indexOf(entry), 1);
      dropClosedEntries();
      opener?.focus?.({ preventScroll: true });
    };
  }, [key]);
  return (
    <div className="modal-bg" onMouseDown={() => void requestClose()}>
      <section
        ref={panel}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onInput={() => { edited.current = true; }}
        onChange={() => { edited.current = true; }}
      >
        <div className="panel-head">
          <h2 id={titleId}>{title}</h2>
          <Btn onClick={() => void requestClose()}>{t("Close")}</Btn>
        </div>
        {children}
      </section>
    </div>
  );
}
// The buttons at the end of a dialog's form: Cancel beside the main action.
// They stay at the bottom of a dialog taller than the screen.
export function ModalActions({ cancel, children }: { cancel: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-actions">
      <Btn type="button" onClick={cancel}>{t("Cancel")}</Btn>
      {children}
    </div>
  );
}
// A menu's items, rendered into <body> with fixed coordinates so that no
// panel's overflow and no neighbouring row can clip or cover them. The menu
// opens upward when there is no room below, takes the focus, moves it with the
// arrow keys, and closes on Escape, on Tab and on a press anywhere else.
export function ActionMenu({ anchor, close, children }: { anchor: HTMLElement; close: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const gap = 4, edge = 8;
    const items = () => [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    function place() {
      if (!menu) return;
      const box = anchor.getBoundingClientRect();
      const fitsBelow = box.bottom + gap + menu.offsetHeight <= window.innerHeight - edge;
      menu.style.top = `${fitsBelow ? box.bottom + gap : Math.max(edge, box.top - gap - menu.offsetHeight)}px`;
      menu.style.left = `${Math.max(edge, box.right - menu.offsetWidth)}px`;
    }
    function pointer(event: PointerEvent) {
      const target = event.target as Node;
      if (!menu?.contains(target) && !anchor.contains(target)) close();
    }
    function key(event: KeyboardEvent) {
      if (event.key === "Escape" || event.key === "Tab") {
        // Handled here alone, so Escape does not also close a dialog behind the menu.
        event.stopPropagation();
        if (event.key === "Escape") event.preventDefault();
        close();
        anchor.focus();
        return;
      }
      const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
      if (!step && event.key !== "Home" && event.key !== "End") return;
      event.preventDefault();
      const all = items();
      const current = all.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? all.length - 1
        : current < 0 ? (step === 1 ? 0 : all.length - 1) : (current + step! + all.length) % all.length;
      all[next]?.focus();
    }
    place();
    items()[0]?.focus({ preventScroll: true });
    window.addEventListener("scroll", place, { capture: true, passive: true });
    window.addEventListener("resize", place);
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("scroll", place, { capture: true });
      window.removeEventListener("resize", place);
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", key, true);
    };
  }, [anchor, close]);
  return createPortal(<div ref={ref} className="menu-items" role="menu">{children}</div>, document.body);
}
export type MenuItem = { label: string; icon?: React.ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean };
// The "⋯" button at the end of a row and the menu of what can be done with
// that row, so that deleting is never one stray click away. Entries that are
// false or null are left out, which lets callers write their conditions inline;
// a row with nothing to offer shows no button.
export function RowMenu({ label, items, disabled = false }: { label: string; items: (MenuItem | false | null | undefined)[]; disabled?: boolean }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  const shown = items.filter((item): item is MenuItem => Boolean(item));
  if (!shown.length) return null;
  return (
    <>
      <button
        type="button"
        className="menu-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        disabled={disabled}
        onClick={(event) => {
          // Inside a <summary> the click must not also open or close its section.
          event.preventDefault();
          event.stopPropagation();
          const button = event.currentTarget;
          setAnchor((open) => (open ? null : button));
        }}
      >
        <MoreHorizontal size={18} />
      </button>
      {anchor && (
        <ActionMenu anchor={anchor} close={close}>
          {shown.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={item.danger ? "danger" : undefined}
              disabled={item.disabled}
              onClick={() => {
                close();
                // A dialog opened by the item returns the focus here when it closes.
                anchor.focus({ preventScroll: true });
                item.onSelect();
              }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </ActionMenu>
      )}
    </>
  );
}
export function DialogHost() {
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
      <div className="modal-body">
        <p>{request.message}</p>
        <ModalActions cancel={() => finish(false)}>
          <Btn className={request.danger ? "danger" : "primary"} onClick={() => finish(true)}>{request.confirmLabel}</Btn>
        </ModalActions>
      </div>
    </Modal>
  );
}
export function PromptDialog({ request, finish }: { request: DialogRequest; finish: (value: string | null) => void }) {
  const [value, setValue] = useState(request.defaultValue || "");
  return <Modal title={request.title} close={() => finish(null)}>
    <form onSubmit={(event) => { event.preventDefault(); if (value.trim()) finish(value); }}>
      <label>{request.message}<input autoFocus value={value} onChange={(event) => setValue(event.target.value)} /></label>
      <ModalActions cancel={() => finish(null)}><Btn className="primary" disabled={!value.trim()}>{request.confirmLabel}</Btn></ModalActions>
    </form>
  </Modal>;
}
// How long a run took, in the largest units that matter.
export function formatDuration(ms: number) {
  const seconds = ms / 1000;
  if (seconds < 60) return t("{seconds} s", { seconds: seconds.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("{minutes} min {seconds} s", { minutes, seconds: Math.floor(seconds % 60) });
  return t("{hours} h {minutes} min", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}
const RUN_STATUSES: Record<string, string> = { running: msg("running"), success: msg("success"), failed: msg("failed"), stopped: msg("stopped") };
export function runStatusLabel(status: string) {
  return RUN_STATUSES[status] ? t(RUN_STATUSES[status]) : status;
}
// A script run's status as a badge: running, success, failed (with its exit
// code, or the time limit that stopped it) or stopped.
export function RunBadge({ run }: { run: Pick<Run, "status" | "exitCode" | "timedOut"> }) {
  const tone = { success: "up", failed: "down", running: "root", stopped: "neutral" }[run.status];
  const detail = run.status !== "failed" ? "" : run.timedOut ? ` · ${t("time limit")}` : run.exitCode !== undefined ? ` · ${t("code {code}", { code: run.exitCode })}` : "";
  // The status reads in lower case inside sentences; as a badge it starts with a capital, like the others.
  const label = runStatusLabel(run.status);
  return <span className={`badge ${tone}`}>{label.charAt(0).toLocaleUpperCase(locale()) + label.slice(1)}{detail}</span>;
}
// What became of a run, in words, for the log viewer.
function describeRun(run: Run) {
  const duration = run.durationMs === undefined ? "" : formatDuration(run.durationMs);
  if (run.status === "running") return t("Running since {time}", { time: new Date(run.startedAt).toLocaleTimeString(locale()) });
  if (run.status === "success") return duration ? t("Finished after {duration}", { duration }) : t("Finished");
  if (run.status === "stopped") {
    if (run.stoppedBy) return duration ? t("Stopped by {name} after {duration}", { name: run.stoppedBy, duration }) : t("Stopped by {name}", { name: run.stoppedBy });
    return duration ? t("Stopped after {duration}", { duration }) : t("Stopped");
  }
  if (run.timedOut) return duration ? t("Stopped by its time limit after {duration}", { duration }) : t("Stopped by its time limit");
  const code = run.exitCode ?? t("unknown");
  return duration ? t("Failed with exit code {code} after {duration}", { code, duration }) : t("Failed with exit code {code}", { code });
}
// A log that follows its source every 2 seconds. A script's log also shows its
// run: whether it still runs, how it ended, and, with canStop, a way to stop
// it. A finished run's log no longer changes, so it is not read again.
export function LiveLogViewer({
  logs,
  close,
  canStop = false,
}: {
  logs: { title: string; path: string; request: unknown };
  close: () => void;
  canStop?: boolean;
}) {
  const [body, setBody] = useState(() => t("Loading logs…")),
    [live, setLive] = useState(true),
    [loading, setLoading] = useState(true),
    [run, setRun] = useState<Run | null>(null),
    [stopping, setStopping] = useState(false),
    [error, setError] = useState("");
  const finished = run !== null && run.status !== "running";
  const following = live && !finished;
  // New output keeps the end of the log in view, until the reader scrolls up.
  const view = useRef<HTMLPreElement>(null);
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    if (view.current && atEnd.current) view.current.scrollTop = view.current.scrollHeight;
  }, [body]);
  // Only sets state after awaiting, so it can run directly from the effect.
  const refreshLogs = useCallback(async () => {
    try {
      const result = await api(logs.path, logs.request, true);
      setBody(result.output || t("No logs available."));
      if (result.run) setRun(result.run);
    } catch (reason) {
      setBody(reason instanceof Error ? reason.message : t("Could not load logs"));
    } finally {
      setLoading(false);
    }
  }, [logs]);
  useEffect(() => {
    if (!following) return;
    // Waits for each response before scheduling the next, so a slow server never
    // gets overlapping requests, and skips reads while the tab is hidden.
    let timer = 0, stopped = false;
    const next = () => {
      timer = window.setTimeout(async () => {
        if (!document.hidden) {
          setLoading(true);
          await refreshLogs();
        }
        if (!stopped) next();
      }, 2000);
    };
    // The rule cannot see that refreshLogs only sets state after awaiting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshLogs().then(() => { if (!stopped) next(); });
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [following, refreshLogs]);
  async function stopRun() {
    if (!run || !await appConfirm(t("Stop this run of {name}? The script and every process it started are ended, and the run is recorded as stopped.", { name: run.scriptName }), t("Stop run"), t("Stop run"), true)) return;
    setError("");
    setStopping(true);
    try {
      await api("script/stop", { runId: run.id });
      await refreshLogs();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("Could not stop the run"));
      setStopping(false);
    }
  }
  return (
    <Modal title={logs.title} close={close}>
      <div className="live-log-controls">
        <span className={following ? "live-status" : ""}>
          {loading && <Loader2 className="spin" size={14} />}
          {run && <RunBadge run={run} />}
          {run ? describeRun(run) : following ? t("Live updates every 2 seconds") : t("Live updates paused")}
        </span>
        <div className="actions">
          {!finished && (
            <Btn type="button" onClick={() => { if (!live) setLoading(true); setLive(!live); }}>
              {live ? <Pause size={15} /> : <Play size={15} />}
              {live ? t("Pause updates") : t("Resume updates")}
            </Btn>
          )}
          {canStop && run?.status === "running" && (
            <Btn type="button" className="danger" disabled={stopping} onClick={stopRun}>
              <Square size={15} />
              {stopping ? t("Stopping…") : t("Stop run")}
            </Btn>
          )}
        </div>
      </div>
      {error && <div className="alert live-log-alert">{error}</div>}
      <pre
        ref={view}
        onScroll={(event) => {
          const log = event.currentTarget;
          atEnd.current = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
        }}
      >{body}</pre>
    </Modal>
  );
}
export function AppLoading() {
  return (
    <div className="app-loading" role="status" aria-live="polite">
      <div>
        <Loader2 className="spin" size={22} />
        <span>{t("Working…")}</span>
      </div>
    </div>
  );
}
export function LoadingScreen() {
  return (
    <main className="loading-screen" role="status" aria-live="polite">
      <div>
        <span className="login-logo">
          <img src="/icon.svg" alt="" />
        </span>
        <Loader2 className="spin" size={22} />
        <p>{t("Loading Linux Server Control…")}</p>
      </div>
    </main>
  );
}
// The server requirement checks from setup and Settings, problems first.
const CHECK_BADGES: Record<PreflightCheck["status"], [className: string, label: string]> = {
  error: ["down", msg("Required")],
  warning: ["down", msg("Missing")],
  info: ["root", msg("Optional")],
  ok: ["up", msg("OK")],
};
export function PreflightList({ checks }: { checks: PreflightCheck[] }) {
  const order = ["error", "warning", "info", "ok"];
  return (
    <ul className="preflight">
      {[...checks].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status)).map((check) => (
        <li key={check.id}>
          <span className={`badge ${CHECK_BADGES[check.status][0]}`}>{t(CHECK_BADGES[check.status][1])}</span>
          <div><b>{check.label}</b><small>{check.detail}</small></div>
        </li>
      ))}
    </ul>
  );
}
