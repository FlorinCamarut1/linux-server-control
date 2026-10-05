"use client";
import { useState } from "react";
import { api } from "@/lib/client-api";
import { Btn, Modal, ModalActions } from "@/components/ui";
import type { S, Schedule } from "@/lib/types";
import { locale, t, tn } from "@/lib/i18n";
// Weekday names in the chosen language, Sunday first like cron (4 January 2026 is a Sunday).
const weekdays = () => Array.from({ length: 7 }, (_, index) => new Intl.DateTimeFormat(locale(), { weekday: "long" }).format(new Date(2026, 0, 4 + index)));
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
    <Modal title={existing ? t("Edit schedule") : t("New schedule")} close={close} guard>
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
            label = (values.label || t("Custom schedule")).trim();
          }
          if (frequency === "minutes") {
            expression = `*/${values.interval} * * * *`;
            label = tn("Every minute|Every {count} minutes", Number(values.interval));
          }
          if (frequency === "hours") {
            expression = `0 */${values.interval} * * *`;
            label = tn("Every hour|Every {count} hours", Number(values.interval));
          }
          if (frequency === "daily") {
            expression = `${minute} ${hour} * * *`;
            label = t("Every day at {time}", { time: values.time });
          }
          if (frequency === "weekly") {
            expression = `${minute} ${hour} * * ${values.weekday}`;
            label = t("Every {weekday} at {time}", { weekday: weekdays()[Number(values.weekday)], time: values.time });
          }
          if (frequency === "monthly") {
            expression = `${minute} ${hour} ${values.monthday} * *`;
            label = t("Day {day} of every month at {time}", { day: values.monthday, time: values.time });
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
            setError(reason instanceof Error ? reason.message : t("Error"));
          }
        }}
      >
        <input type="hidden" name="id" defaultValue={initial?.id} />
        <label>
          {t("Run")}
          <select value={targetKind} onChange={(event) => setTargetKind(event.target.value as "script" | "command")}>
            <option value="script">{t("An approved script")}</option>
            <option value="command">{t("A custom command")}</option>
          </select>
        </label>
        {targetKind === "command" ? (
          <label>
            {t("Custom command")}
            <input name="command" defaultValue={initial?.command} required maxLength={2000} placeholder="/usr/local/bin/task --option" />
            <small>{t("This one-line command runs through cron as the selected user.")}</small>
          </label>
        ) : (
          <label>
            {t("Script")}
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
            {t("Run option")}
            <select value={args} onChange={(event) => setArgs(event.target.value)}>
              <option value="">{t("No arguments")}</option>
              {schedulable.map((option) => <option key={`${option.label}-${option.value}`} value={option.value}>{option.label}{option.value ? ` (${option.value})` : ""}</option>)}
              {args && !schedulable.some((option) => option.value === args) && <option value={args}>{args}</option>}
            </select>
            <small>{t("The script's time limit and variables hold for its scheduled runs too. Options that need a file or a typed value can only be run by hand.")}</small>
          </label>
        )}
        <label>
          {t("Run as")}
          <select name="runAs" defaultValue={initial?.runAs || "user"}>
            <option value="user">{t("SSH user")}</option>
            <option value="root" disabled={!rootAccess}>
              root{rootAccess ? "" : ` (${t("not enabled")})`}
            </option>
          </select>
          {!rootAccess && (
            <small>{t("Install both root helpers on the server to use this option.")}</small>
          )}
        </label>
        <label>
          {t("Frequency")}
          <select
            value={frequency}
            onChange={(event) => setFrequency(event.target.value)}
          >
            <option value="minutes">{t("Every few minutes")}</option>
            <option value="hours">{t("Every few hours")}</option>
            <option value="daily">{t("Every day")}</option>
            <option value="weekly">{t("Every week")}</option>
            <option value="monthly">{t("Every month")}</option>
            <option value="custom">{t("Custom cron expression")}</option>
          </select>
        </label>
        {(frequency === "minutes" || frequency === "hours") && (
          <label>
            {t("Interval")}
            <select name="interval">
              {(frequency === "minutes"
                ? [5, 10, 15, 20, 30]
                : [1, 2, 3, 4, 6, 8, 12]
              ).map((value) => (
                <option key={value} value={value}>
                  {frequency === "minutes" ? tn("Every minute|Every {count} minutes", value) : tn("Every hour|Every {count} hours", value)}
                </option>
              ))}
            </select>
          </label>
        )}
        {(frequency === "daily" ||
          frequency === "weekly" ||
          frequency === "monthly") && (
          <label>
            {t("Time")}
            <input name="time" type="time" defaultValue="03:00" required />
          </label>
        )}
        {frequency === "weekly" && (
          <label>
            {t("Day of week")}
            <select name="weekday">
              {weekdays().map((day, index) => (
                <option key={day} value={index}>
                  {day}
                </option>
              ))}
            </select>
          </label>
        )}
        {frequency === "monthly" && (
          <label>
            {t("Day of month")}
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
              {t("Cron expression")}
              <input
                name="expression"
                required
                defaultValue={initial?.expression}
                placeholder="0 3 * * *"
              />
              <small>{t("Use five cron fields, or @reboot.")}</small>
            </label>
            <label>
              {t("Description")}
              <input name="label" maxLength={80} defaultValue={initial?.label} placeholder={t("Every day at {time}", { time: "03:00" })} />
            </label>
          </>
        )}
        {error && <div className="alert">{error}</div>}
        <ModalActions cancel={close}>
          <Btn className="primary">{existing ? t("Save schedule") : t("Create schedule")}</Btn>
        </ModalActions>
      </form>
    </Modal>
  );
}
