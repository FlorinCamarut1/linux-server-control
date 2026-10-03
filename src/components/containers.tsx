"use client";
import { useState } from "react";
import { api } from "@/lib/client-api";
import { Btn } from "@/components/ui";
import { msg, t } from "@/lib/i18n";
import type { ContainerLink } from "@/lib/container-links";
import type { C } from "@/lib/types";
import {
  ChevronDown,
  Circle,
  Container,
  ExternalLink,
  Loader2,
  Play,
  RotateCcw,
  Square,
  Terminal,
} from "lucide-react";
export function ContainerRow({
  c,
  links,
  busy,
  act,
  logs,
  readOnly = false,
}: {
  c: C;
  links: ContainerLink[];
  busy: string;
  act: (k: string, p: string, b: unknown) => void;
  logs: (t: string, p: string, b: unknown) => void;
  readOnly?: boolean;
}) {
  const up = c.State === "running",
    key = (a: string) => `${c.ID}-${a}`;
  // Docker computes sizes slowly, so the size is only read when the row is opened.
  const [size, setSize] = useState<string | null>(null);
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
          <b>{c.Names}</b>
          <span className="path">{c.Image}</span>
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
        <span className={`badge ${up ? "up" : "down"}`}>
          <Circle size={8} fill="currentColor" />
          {up ? t("Up") : t("Down")}
        </span>
        <div className="uptime">{c.Status}</div>
        <ChevronDown className="chevron" size={18} />
      </summary>
      <div className="details">
        <dl>
          {[
            [msg("Container ID"), c.ID],
            [msg("Created"), c.CreatedAt],
            [msg("Networks"), c.Networks],
            [msg("Ports"), c.Ports || t("No published ports")],
            [msg("Mounts"), c.Mounts],
            [msg("Size"), size ?? c.Size],
          ].map(([a, b]) => (
            <div key={a}>
              <dt>{t(String(a))}</dt>
              <dd>{b || "—"}</dd>
            </div>
          ))}
        </dl>
        <div className="actions">
          {links.map((link) => (
            <a key={link.url} className="button" href={link.url} target="_blank" rel="noopener noreferrer" title={link.url}>
              <ExternalLink size={15} />
              {t("Open {target}", { target: link.label })}
            </a>
          ))}
          <Btn
            onClick={() =>
              logs(c.Names, "container", { name: c.Names, action: "logs" })
            }
          >
            <Terminal size={15} />
            {t("Logs")}
          </Btn>
          {readOnly ? null : up ? (
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
                {t("Restart")}
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
                {t("Stop")}
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
              {t("Start")}
            </Btn>
          )}
        </div>
      </div>
    </details>
  );
}
