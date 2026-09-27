"use client";
import { Btn } from "@/components/ui";
import type { C } from "@/lib/types";
import {
  ChevronDown,
  Circle,
  Container,
  Loader2,
  Play,
  RotateCcw,
  Square,
  Terminal,
} from "lucide-react";
export function ContainerRow({
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
