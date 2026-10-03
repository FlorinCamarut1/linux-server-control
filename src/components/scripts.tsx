"use client";
import { useRef, useState } from "react";
import { api } from "@/lib/client-api";
import { FileBrowser, DirectoryBrowser, ScriptBrowser } from "@/components/files";
import { appConfirm, Btn, Modal, rich } from "@/components/ui";
import { t } from "@/lib/i18n";
import type { RunOption, S } from "@/lib/types";
import {
  FolderOpen,
  Trash2,
} from "lucide-react";
export function ScriptForm({
  initial,
  folders,
  rootAccess,
  rootStop = false,
  close,
  done,
}: {
  initial: S | null;
  folders: string[];
  rootAccess: boolean;
  // Whether the root script helper can stop runs, which a time limit needs.
  rootStop?: boolean;
  close: () => void;
  done: () => void;
}) {
  const [err, setErr] = useState(""),
    [scriptPath, setScriptPath] = useState(initial?.path || ""),
    [showBrowser, setShowBrowser] = useState(false),
    [runAs, setRunAs] = useState<"user" | "root">(initial?.runAs || "user"),
    [hasRunOptions, setHasRunOptions] = useState(!!initial?.runOptions?.length),
    [runOptions, setRunOptions] = useState<RunOption[]>(
      initial?.runOptions ||
        (initial?.argumentHint
          ? [{ label: t("Default option"), value: initial.argumentHint, description: t("Imported from the previous argument prompt") }]
          : []),
    );
  const change = (index: number, patch: Partial<RunOption>) =>
    setRunOptions(runOptions.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  const variables = Object.entries(initial?.variables ?? {}).map(([name, value]) => `${name}=${value}`).join("\n");
  return (
    <Modal title={initial ? t("Edit script") : t("Add script")} close={close}>
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
            setErr(x instanceof Error ? x.message : t("Error"));
          }
        }}
      >
        <input type="hidden" name="id" defaultValue={initial?.id} />
        <label>
          {t("Name")}
          <input name="name" required defaultValue={initial?.name} />
        </label>
        <label>
          {t("Server path")}
          <div className="path-input">
            <input
              name="path"
              required
              value={scriptPath}
              onChange={(event) => setScriptPath(event.target.value)}
            />
            <Btn type="button" onClick={() => setShowBrowser((open) => !open)}>
              <FolderOpen size={16} />
              {t("Browse")}
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
          {t("Folder")}
          <select
            name="folder"
            defaultValue={initial?.folder}
          >
            <option value="">{t("Unfiled")}</option>
            {folders.map((folder) => (
              <option key={folder} value={folder}>
                {folder}
              </option>
            ))}
          </select>
          <small>{t("Create folders from the Scripts page.")}</small>
        </label>
        <label>
          {t("Run as")}
          <select name="runAs" value={runAs} onChange={(event) => setRunAs(event.target.value === "root" ? "root" : "user")}>
            <option value="user">{t("SSH user")}</option>
            <option value="root" disabled={!rootAccess}>root{rootAccess ? "" : ` (${t("not enabled")})`}</option>
          </select>
          <small>{t("Root is available only for script folders approved by the server helper.")}</small>
        </label>
        {/* How the script runs belongs here, not in the script: the conditions
            hold for runs from the dashboard and, but for the question, for its schedules. */}
        <fieldset className="run-conditions">
          <legend>{t("Run conditions")}</legend>
          <label>
            {t("Time limit (minutes)")}
            <input name="timeLimitMinutes" type="number" min={1} max={10080} step={1} inputMode="numeric" defaultValue={initial?.timeLimitMinutes ?? ""} placeholder={t("No limit")} />
            <small>{t("A run that takes longer is stopped and counts as failed. Leave empty for no limit.")}{rootAccess && !rootStop ? ` ${t("On root scripts this needs the current root script helper.")}` : ""}</small>
          </label>
          <label>
            {t("Variables")}
            <textarea name="variables" rows={3} spellCheck={false} disabled={runAs === "root"} defaultValue={variables} placeholder={"KEEP_SNAPSHOTS=3\nBACKUP_DIR=/mnt/storage/backups"} />
            <small>{runAs === "root"
              ? t("Root scripts take arguments only: the dashboard may not change how a root script behaves beyond them.")
              : t("One NAME=value per line, given to the script as environment variables on every run, scheduled ones included; the script reads them as {example}.", { example: "${KEEP_SNAPSHOTS:-1}" })}</small>
          </label>
          <label className="option-toggle">
            <input type="checkbox" name="singleRun" value="true" defaultChecked={!!initial?.singleRun} />
            <span>{t("Only one run at a time")}<small>{t("Run is refused while a run started from the dashboard is still going.")}</small></span>
          </label>
          <label className="option-toggle">
            <input type="checkbox" name="confirmRun" value="true" defaultChecked={!!initial?.confirmRun} />
            <span>{t("Ask before each run")}<small>{t("For scripts that change or delete things; the dashboard asks before starting one.")}</small></span>
          </label>
          <label className="option-toggle">
            <input type="checkbox" name="notifySuccess" value="true" defaultChecked={!!initial?.notifySuccess} />
            <span>{t("Announce successful runs")}<small>{t("Notification channels with “Run succeeded” are told of each successful run, not only of failures.")}</small></span>
          </label>
        </fieldset>
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
          {t("Ask me to choose an option before running")}
        </label>
        {hasRunOptions && (
          <section className="run-options-editor">
            <div className="run-options-head">
              <div>
                <b>{t("Run options")}</b>
                <small>{t("Each option becomes an item in the Run dropdown.")}</small>
              </div>
              <Btn
                type="button"
                onClick={() => setRunOptions([...runOptions, { label: "", value: "", description: "", needsFile: false }])}
              >
                {t("Add option")}
              </Btn>
            </div>
            {runOptions.map((option, index) => (
              <div className="run-option-fields" key={index}>
                <input
                  className="option-name"
                  aria-label={t("Option name")}
                  placeholder={t("Option name")}
                  value={option.label}
                  onChange={(event) => change(index, { label: event.target.value })}
                />
                <input
                  className="option-arguments"
                  aria-label={t("Arguments")}
                  placeholder={t("Arguments, e.g. --latest --yes; empty for none")}
                  value={option.value}
                  onChange={(event) => change(index, { value: event.target.value })}
                />
                <Btn
                  type="button"
                  className="option-remove danger"
                  aria-label={option.label ? t("Remove {name}", { name: option.label }) : t("Remove option")}
                  disabled={runOptions.length === 1}
                  onClick={() => setRunOptions(runOptions.filter((_, i) => i !== index))}
                >
                  <Trash2 size={15} />
                </Btn>
                <input
                  className="option-description"
                  aria-label={t("Explanation")}
                  placeholder={t("Short explanation")}
                  value={option.description}
                  onChange={(event) => change(index, { description: event.target.value })}
                />
                <input
                  className="option-input"
                  aria-label={t("Ask for a value")}
                  title={t("Asked when running; the value takes the place of {placeholder} in the arguments, or follows them", { placeholder: "{value}" })}
                  placeholder={t("Ask for a value, e.g. Month (YYYY-MM)")}
                  value={option.input ?? ""}
                  onChange={(event) => change(index, { input: event.target.value })}
                />
                <label className="option-file-toggle">
                  <input
                    type="checkbox"
                    checked={!!option.needsFile}
                    onChange={(event) => change(index, { needsFile: event.target.checked })}
                  />
                  {t("Requires file")}
                </label>
              </div>
            ))}
            <small className="run-options-note">{rich(t("An option may have no arguments. A value asked for takes the place of {placeholder} in the arguments, or follows them."), { placeholder: <code>{"{value}"}</code> })}</small>
          </section>
        )}
        {err && <div className="alert">{err}</div>}
        <Btn className="primary">{t("Save")}</Btn>
      </form>
    </Modal>
  );
}
const NEW_SCRIPT = "#!/usr/bin/env bash\nset -eu\n\n# Add commands here\n";
export function CustomScriptForm({
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
  // Closing by a stray click outside the form, or by Escape, must not lose a written script.
  const content = useRef<HTMLTextAreaElement>(null);
  async function closeForm() {
    if ((content.current?.value ?? NEW_SCRIPT) === NEW_SCRIPT || await appConfirm(t("Close without creating the script? What you wrote is discarded."), t("Unsaved script"), t("Discard"), true)) close();
  }
  return (
    <Modal title={t("New custom script")} close={closeForm}>
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
            setError(reason instanceof Error ? reason.message : t("Could not create script"));
          }
        }}
      >
        <label>
          {t("Name")}
          <input name="name" required maxLength={80} placeholder={t("My maintenance task")} />
        </label>
        <label>
          {t("Script filename")}
          <input name="filename" required pattern="[A-Za-z0-9][A-Za-z0-9._\-]*\.sh" placeholder="maintenance.sh" />
          <small>{t("Only letters, numbers, dots, dashes, and underscores. The filename must end in .sh.")}</small>
        </label>
        <label>
          {t("Server folder")}
          <div className="path-input">
            <input name="directory" required value={directory} onChange={(event) => setDirectory(event.target.value)} placeholder={t("Choose an allowed folder")} />
            <Btn type="button" onClick={() => setShowBrowser((open) => !open)}>
              <FolderOpen size={16} />{t("Browse")}
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
          {t("Dashboard folder")}
          <select name="folder" defaultValue="">
            <option value="">{t("Unfiled")}</option>
            {folders.map((folder) => <option key={folder} value={folder}>{folder}</option>)}
          </select>
        </label>
        <label>
          {t("Run as")}
          <select name="runAs" defaultValue="user">
            <option value="user">{t("SSH user")}</option>
            <option value="root" disabled={!rootAccess}>root{rootAccess ? "" : ` (${t("not enabled")})`}</option>
          </select>
          <small>{t("Root scripts must be created inside a folder approved by the server helper.")}</small>
        </label>
        <label>
          {t("Script content")}
          <textarea ref={content} name="content" rows={12} required spellCheck={false} defaultValue={NEW_SCRIPT} />
          <small>{t("The script runs as the dashboard SSH user. It is saved as an executable file inside the selected allowed folder.")}</small>
        </label>
        {error && <div className="alert">{error}</div>}
        <Btn className="primary">{t("Create script")}</Btn>
      </form>
    </Modal>
  );
}
export function RunScriptForm({
  script,
  close,
  done,
}: {
  script: S;
  close: () => void;
  done: (script: S, runId: string) => void;
}) {
  const [error, setError] = useState(""),
    [selected, setSelected] = useState("0"),
    [selectedFile, setSelectedFile] = useState(""),
    [value, setValue] = useState(""),
    [showFileBrowser, setShowFileBrowser] = useState(false),
    options = script.runOptions || [];
  const option = options[Number(selected)];
  return (
    <Modal title={t("Run {name}", { name: script.name })} close={close}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (script.confirmRun && !await appConfirm(t("Run “{name}” with “{option}”?", { name: script.name, option: option?.label ?? "" }), t("Run script"), t("Run"), true)) return;
          try {
            const result = await api("script/run", { id: script.id, option: selected, file: selectedFile, value });
            done(script, result.run.id);
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : t("Could not start script"));
          }
        }}
      >
        <label>
          {t("Choose an option")}
          <select
            autoFocus
            value={selected}
            onChange={(event) => {
              setSelected(event.target.value);
              setSelectedFile("");
              setValue("");
              setShowFileBrowser(false);
            }}
          >
            {options.map((option, index) => (
              <option key={`${option.label}-${index}`} value={index}>{option.label}</option>
            ))}
          </select>
          <small>{option?.description || option?.value}</small>
        </label>
        {option?.input && (
          <label>
            {option.input}
            <input autoFocus required maxLength={500} value={value} onChange={(event) => setValue(event.target.value)} spellCheck={false} />
          </label>
        )}
        {option?.needsFile && (
          <section className="run-file-picker">
            <b>{t("Select a file")}</b>
            <small>{rich(t("The selected path is inserted after {file}, before confirmation flags such as {yes}."), { file: <code>--file</code>, yes: <code>--yes</code> })}</small>
            {selectedFile && <code>{selectedFile}</code>}
            <Btn type="button" onClick={() => setShowFileBrowser((open) => !open)}>
              <FolderOpen size={16} />
              {selectedFile ? t("Change file") : t("Choose file")}
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
        <Btn className="primary" disabled={(!!option?.needsFile && !selectedFile) || (!!option?.input && !value.trim())}>{t("Run script")}</Btn>
      </form>
    </Modal>
  );
}
export function FolderForm({ close, done }: { close: () => void; done: () => void }) {
  const [error, setError] = useState("");
  return (
    <Modal title={t("New folder")} close={close}>
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
            setError(reason instanceof Error ? reason.message : t("Error"));
          }
        }}
      >
        <label>
          {t("Folder name")}
          <input name="name" autoFocus required maxLength={60} />
        </label>
        {error && <div className="alert">{error}</div>}
        <Btn className="primary">{t("Create folder")}</Btn>
      </form>
    </Modal>
  );
}
