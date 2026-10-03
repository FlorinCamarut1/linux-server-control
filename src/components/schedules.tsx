"use client";
import { useState } from "react";
import { api } from "@/lib/client-api";
import { Btn, Modal } from "@/components/ui";
import type { S, Schedule } from "@/lib/types";
export function ScheduleForm({
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
  // The Scripts page opens this form for a script that has no schedule yet,
  // with the script chosen: that is a new schedule, not an edit.
  const existing = !!initial?.id;
  const [frequency, setFrequency] = useState(existing ? "custom" : "daily"),
    [targetKind, setTargetKind] = useState<"script" | "command">(
      initial?.command ? "command" : "script",
    ),
    [scriptId, setScriptId] = useState(initial?.scriptId || scripts[0]?.id || ""),
    [args, setArgs] = useState(initial?.arguments ?? ""),
    [error, setError] = useState("");
  // A schedule can run one of its script's options; one that needs a file or a
  // typed value needs someone to run it.
  const schedulable = (scripts.find((script) => script.id === scriptId)?.runOptions ?? []).filter((option) => !option.needsFile && !option.input);
  return (
    <Modal title={existing ? "Edit schedule" : "New schedule"} close={close}>
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
              arguments: targetKind === "script" ? args : "",
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
            <select name="scriptId" required={targetKind === "script"} value={scriptId} onChange={(event) => { setScriptId(event.target.value); setArgs(""); }}>
              {scripts.map((script) => (
                <option key={script.id} value={script.id}>
                  {script.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {targetKind === "script" && (schedulable.length > 0 || args) && (
          <label>
            Run option
            <select value={args} onChange={(event) => setArgs(event.target.value)}>
              <option value="">No arguments</option>
              {schedulable.map((option) => <option key={`${option.label}-${option.value}`} value={option.value}>{option.label}{option.value ? ` (${option.value})` : ""}</option>)}
              {args && !schedulable.some((option) => option.value === args) && <option value={args}>{args}</option>}
            </select>
            <small>The script&apos;s time limit and variables hold for its scheduled runs too. Options that need a file or a typed value can only be run by hand.</small>
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
            <small>Install both root helpers on the server to use this option.</small>
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
        <Btn className="primary">{existing ? "Save schedule" : "Create schedule"}</Btn>
      </form>
    </Modal>
  );
}
