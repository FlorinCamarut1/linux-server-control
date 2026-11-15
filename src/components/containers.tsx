"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client-api";
import { appConfirm, Btn, PAGE_REFRESH } from "@/components/ui";
import { locale, msg, t } from "@/lib/i18n";
import { type ContainerLink, label } from "@/lib/container-links";
import type { C, ContainerUse } from "@/lib/types";
import {
  ChevronDown,
  Circle,
  CircleArrowUp,
  Container,
  ExternalLink,
  Play,
  RotateCcw,
  Square,
  Terminal,
} from "lucide-react";
// The Compose project a container belongs to, if Compose started it.
export const composeProject = (container: Pick<C, "Labels">) => label(container.Labels, "com.docker.compose.project");
// What is wrong with a container that Docker still counts as started: its
// health check fails, or it keeps starting again. Empty when nothing is.
export function containerProblem(container: Pick<C, "State" | "Status">) {
  if (container.State === "restarting") return t("Restarting");
  if (/\(unhealthy\)/.test(container.Status)) return t("Unhealthy");
  return "";
}
// Docker takes a second or two to measure the containers, so their use is read
// only while the Containers page is shown: when it opens, every half minute,
// and on Refresh.
const STATS_REFRESH_MS = 30 * 1000;
export function useContainerStats(shown: boolean) {
  const [stats, setStats] = useState<Record<string, ContainerUse>>({});
  useEffect(() => {
    if (!shown) return;
    let current = true, loading = false;
    const load = () => {
      if (loading) return;
      loading = true;
      api("container/stats", undefined, true)
        .then((result) => { if (current) setStats(result.stats ?? {}); })
        // Without Docker there is nothing to show; the page says so itself.
        .catch(() => {})
        .finally(() => { loading = false; });
    };
    load();
    const timer = setInterval(() => { if (!document.hidden) load(); }, STATS_REFRESH_MS);
    window.addEventListener(PAGE_REFRESH, load);
    return () => { current = false; clearInterval(timer); window.removeEventListener(PAGE_REFRESH, load); };
  }, [shown]);
  return stats;
}
const one = (value: number) => value.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
export function ContainerRow({
  c,
  links,
  busy,
  act,
  logs,
  update,
  use,
  readOnly = false,
}: {
  c: C;
  links: ContainerLink[];
  busy: ReadonlySet<string>;
  act: (k: string, p: string, b: unknown, done?: string) => Promise<void>;
  logs: (t: string, p: string, b: unknown, follow?: string) => void;
  // Pulls the newest image and starts the container again with it.
  update: (c: C) => Promise<void>;
  // Its CPU and memory use, once Docker has measured it.
  use?: ContainerUse;
  readOnly?: boolean;
}) {
  const up = c.State === "running",
    key = (a: string) => `${c.ID}-${a}`;
  // Docker computes sizes slowly, so the size is only read when the row is opened.
  const [size, setSize] = useState<string | null>(null);
  const control = (action: "start" | "stop" | "restart", done: string) => act(key(action), "container", { name: c.Names, action }, done);
  // While one of its actions goes on, the others wait; other containers do not.
  const working = ["start", "stop", "restart", "update"].some((action) => busy.has(key(action)));
  const problem = containerProblem(c);
  return (
    <details
      className="container-row"
      onToggle={(event) => {
        if (!event.currentTarget.open || size !== null) return;
        setSize(t("Loading…"));
        api("container/size", { name: c.Names }, true)
          .then((result) => setSize(result.size || "—"))
          .catch(() => setSize(t("Unavailable")));
      }}
    >
      <summary>
        <div className="service-icon">
          <Container size={20} />
        </div>
        <div className="service-main">
          <b title={c.Names}>{c.Names}</b>
          <span className="path" title={c.Image}>{c.Image}</span>
          {/* Where the status column has no room, the status is a line here. */}
          <span className="service-status">{c.Status}</span>
          {up && use && (
            <span className="container-use" dir="ltr">
              {[use.cpuPercent !== null ? `CPU ${one(use.cpuPercent)}%` : "", use.memory ? `RAM ${use.memory}` : ""].filter(Boolean).join(" · ")}
            </span>
          )}
        </div>
        <div className="service-links">
          {links.slice(0, 2).map((link) => (
            // Opening a link must not also toggle the row.
            <a key={link.url} className="link-chip" href={link.url} target="_blank" rel="noopener noreferrer" title={t("Open {target}", { target: link.url })} onClick={(event) => event.stopPropagation()}>
              <ExternalLink size={13} />
              {link.label}
            </a>
          ))}
          {links.length > 2 && <span className="link-chip more" title={links.slice(2).map((link) => link.url).join("\n")}>+{links.length - 2}</span>}
        </div>
        <span className={`badge ${up && !problem ? "up" : "down"}`}>
          <Circle size={8} fill="currentColor" />
          {problem || (up ? t("Up") : t("Down"))}
        </span>
        <div className="uptime" title={c.Status}>{c.Status}</div>
        <ChevronDown className="chevron" size={18} />
      </summary>
      <div className="details">
        {/* What can be done comes first, above the facts. */}
        <div className="actions">
          <Btn
            onClick={() =>
              logs(c.Names, "container", { name: c.Names, action: "logs" }, `container/logs?name=${encodeURIComponent(c.Names)}`)
            }
          >
            <Terminal size={15} />
            {t("Logs")}
          </Btn>
          {readOnly ? null : up ? (
            <>
              <Btn disabled={working} onClick={() => control("restart", t("{name} restarted", { name: c.Names }))}>
                <RotateCcw size={15} />
                {t("Restart")}
              </Btn>
              <Btn
                className="danger"
                disabled={working}
                onClick={async () => {
                  if (await appConfirm(t("Stop {name}? What it serves is unavailable until it is started again.", { name: c.Names }), t("Stop container"), t("Stop"), true))
                    await control("stop", t("{name} stopped", { name: c.Names }));
                }}
              >
                <Square size={15} />
                {t("Stop")}
              </Btn>
            </>
          ) : (
            <Btn className="primary" disabled={working} onClick={() => control("start", t("{name} started", { name: c.Names }))}>
              <Play size={15} />
              {t("Start")}
            </Btn>
          )}
          {/* Compose knows where a container's image and settings come from. */}
          {!readOnly && composeProject(c) && (
            <Btn disabled={working} onClick={() => update(c)}>
              <CircleArrowUp size={15} />
              {t("Update")}
            </Btn>
          )}
          {links.map((link) => (
            <a key={link.url} className="button" href={link.url} target="_blank" rel="noopener noreferrer" title={link.url}>
              <ExternalLink size={15} />
              {t("Open {target}", { target: link.label })}
            </a>
          ))}
        </div>
        {/* Technical values read left to right in every language. */}
        <dl>
          {[
            [msg("Name"), c.Names],
            [msg("Image"), c.Image],
            [msg("Status"), c.Status],
            [msg("Container ID"), c.ID],
            [msg("Created"), c.CreatedAt],
            [msg("Networks"), c.Networks],
            [msg("Ports"), c.Ports || t("No published ports")],
            [msg("Mounts"), c.Mounts],
            [msg("Compose project"), composeProject(c)],
            [msg("Memory"), up && use?.memory ? `${use.memory}${use.memoryPercent !== null ? ` (${one(use.memoryPercent)}%)` : ""}` : ""],
            [msg("Size"), size ?? c.Size],
          ].map(([a, b]) => (
            <div key={a}>
              <dt>{t(String(a))}</dt>
              <dd dir="ltr">{b || "—"}</dd>
            </div>
          ))}
        </dl>
      </div>
    </details>
  );
}
