"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client-api";
import {
  Loader2,
  Play,
  Square,
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
export async function appConfirm(message: string, title = "Confirm action", confirmLabel = "Confirm", danger = false) {
  return (await requestDialog({ kind: "confirm", title, message, confirmLabel, danger })) === true;
}
export async function appPrompt(message: string, defaultValue = "", title = "Enter a value", confirmLabel = "Continue") {
  const result = await requestDialog({ kind: "prompt", title, message, confirmLabel, defaultValue });
  return typeof result === "string" ? result : null;
}
export const Btn = ({
  className = "",
  ...p
}: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button className={`button ${className}`} {...p} />
);
export function Panel({
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
export function Metric({
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
export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}
export function formatPercent(used: number, total: number) {
  return total > 0 ? `${Math.round((used / total) * 100)}% used` : "Unavailable";
}
export function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
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
export function Modal({
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
        <div className="actions">
          <Btn onClick={() => finish(false)}>Cancel</Btn>
          <Btn className={request.danger ? "danger" : "primary"} onClick={() => finish(true)}>{request.confirmLabel}</Btn>
        </div>
      </div>
    </Modal>
  );
}
export function PromptDialog({ request, finish }: { request: DialogRequest; finish: (value: string | null) => void }) {
  const [value, setValue] = useState(request.defaultValue || "");
  return <Modal title={request.title} close={() => finish(null)}>
    <form onSubmit={(event) => { event.preventDefault(); if (value.trim()) finish(value); }}>
      <label>{request.message}<input autoFocus value={value} onChange={(event) => setValue(event.target.value)} /></label>
      <div className="actions"><Btn type="button" onClick={() => finish(null)}>Cancel</Btn><Btn className="primary" disabled={!value.trim()}>{request.confirmLabel}</Btn></div>
    </form>
  </Modal>;
}
export function LiveLogViewer({
  logs,
  close,
}: {
  logs: { title: string; path: string; request: unknown };
  close: () => void;
}) {
  const [body, setBody] = useState("Loading logs…"),
    [live, setLive] = useState(true),
    [loading, setLoading] = useState(true);
  // Only sets state after awaiting, so it can run directly from the effect.
  const refreshLogs = useCallback(async () => {
    try {
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
  }, [live, refreshLogs]);
  return (
    <Modal title={logs.title} close={close}>
      <div className="live-log-controls">
        <span className={live ? "live-status" : ""}>
          {loading && <Loader2 className="spin" size={14} />}
          {live ? "Live updates every 2 seconds" : "Live updates stopped"}
        </span>
        <Btn type="button" onClick={() => { if (!live) setLoading(true); setLive(!live); }}>
          {live ? <Square size={15} /> : <Play size={15} />}
          {live ? "Stop live" : "Start live"}
        </Btn>
      </div>
      <pre>{body}</pre>
    </Modal>
  );
}
export function AppLoading() {
  return (
    <div className="app-loading" role="status" aria-live="polite">
      <div>
        <Loader2 className="spin" size={22} />
        <span>Working…</span>
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
        <p>Loading Linux Server Control…</p>
      </div>
    </main>
  );
}
