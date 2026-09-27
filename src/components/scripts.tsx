"use client";
import { useState } from "react";
import { api } from "@/lib/client-api";
import { FileBrowser, DirectoryBrowser, ScriptBrowser } from "@/components/files";
import { Btn, Modal } from "@/components/ui";
import type { RunOption, S } from "@/lib/types";
import {
  FolderOpen,
  Trash2,
} from "lucide-react";
export function ScriptForm({
  initial,
  folders,
  rootAccess,
  close,
  done,
}: {
  initial: S | null;
  folders: string[];
  rootAccess: boolean;
  close: () => void;
  done: () => void;
}) {
  const [err, setErr] = useState(""),
    [scriptPath, setScriptPath] = useState(initial?.path || ""),
    [showBrowser, setShowBrowser] = useState(false),
    [hasRunOptions, setHasRunOptions] = useState(!!initial?.runOptions?.length),
    [runOptions, setRunOptions] = useState<RunOption[]>(
      initial?.runOptions ||
        (initial?.argumentHint
          ? [{ label: "Default option", value: initial.argumentHint, description: "Imported from the previous argument prompt" }]
          : []),
    );
  return (
    <Modal title={initial ? "Edit script" : "Add script"} close={close}>
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
            setErr(x instanceof Error ? x.message : "Error");
          }
        }}
      >
        <input type="hidden" name="id" defaultValue={initial?.id} />
        <label>
          Name
          <input name="name" required defaultValue={initial?.name} />
        </label>
        <label>
          Server path
          <div className="path-input">
            <input
              name="path"
              required
              value={scriptPath}
              onChange={(event) => setScriptPath(event.target.value)}
            />
            <Btn type="button" onClick={() => setShowBrowser((open) => !open)}>
              <FolderOpen size={16} />
              Browse
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
          Folder
          <select
            name="folder"
            defaultValue={initial?.folder}
          >
            <option value="">Unfiled</option>
            {folders.map((folder) => (
              <option key={folder} value={folder}>
                {folder}
              </option>
            ))}
          </select>
          <small>Create folders from the Scripts page.</small>
        </label>
        <label>
          Run as
          <select name="runAs" defaultValue={initial?.runAs || "user"}>
            <option value="user">SSH user</option>
            <option value="root" disabled={!rootAccess}>root{rootAccess ? "" : " (not enabled)"}</option>
          </select>
          <small>Root is available only for script folders approved by the server helper.</small>
        </label>
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
          Ask me to choose an option before running
        </label>
        {hasRunOptions && (
          <section className="run-options-editor">
            <div className="run-options-head">
              <div>
                <b>Run options</b>
                <small>Each option becomes an item in the Run dropdown.</small>
              </div>
              <Btn
                type="button"
                onClick={() => setRunOptions([...runOptions, { label: "", value: "", description: "", needsFile: false }])}
              >
                Add option
              </Btn>
            </div>
            {runOptions.map((option, index) => (
              <div className="run-option-fields" key={index}>
                <input
                  aria-label="Option name"
                  placeholder="Option name"
                  value={option.label}
                  onChange={(event) => setRunOptions(runOptions.map((item, i) => i === index ? { ...item, label: event.target.value } : item))}
                />
                <input
                  aria-label="Arguments"
                  placeholder="Arguments, e.g. --latest --yes"
                  value={option.value}
                  onChange={(event) => setRunOptions(runOptions.map((item, i) => i === index ? { ...item, value: event.target.value } : item))}
                />
                <input
                  aria-label="Explanation"
                  placeholder="Short explanation"
                  value={option.description}
                  onChange={(event) => setRunOptions(runOptions.map((item, i) => i === index ? { ...item, description: event.target.value } : item))}
                />
                <label className="option-file-toggle">
                  <input
                    type="checkbox"
                    checked={!!option.needsFile}
                    onChange={(event) => setRunOptions(runOptions.map((item, i) => i === index ? { ...item, needsFile: event.target.checked } : item))}
                  />
                  Requires file
                </label>
                <Btn
                  type="button"
                  className="danger"
                  aria-label={`Remove ${option.label || "option"}`}
                  disabled={runOptions.length === 1}
                  onClick={() => setRunOptions(runOptions.filter((_, i) => i !== index))}
                >
                  <Trash2 size={15} />
                </Btn>
              </div>
            ))}
          </section>
        )}
        {err && <div className="alert">{err}</div>}
        <Btn className="primary">Save</Btn>
      </form>
    </Modal>
  );
}
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
  return (
    <Modal title="New custom script" close={close}>
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
            setError(reason instanceof Error ? reason.message : "Could not create script");
          }
        }}
      >
        <label>
          Name
          <input name="name" required maxLength={80} placeholder="My maintenance task" />
        </label>
        <label>
          Script filename
          <input name="filename" required pattern="[A-Za-z0-9][A-Za-z0-9._-]*\\.sh" placeholder="maintenance.sh" />
          <small>Only letters, numbers, dots, dashes, and underscores. The filename must end in .sh.</small>
        </label>
        <label>
          Server folder
          <div className="path-input">
            <input name="directory" required value={directory} onChange={(event) => setDirectory(event.target.value)} placeholder="Choose an allowed folder" />
            <Btn type="button" onClick={() => setShowBrowser((open) => !open)}>
              <FolderOpen size={16} />Browse
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
          Dashboard folder
          <select name="folder" defaultValue="">
            <option value="">Unfiled</option>
            {folders.map((folder) => <option key={folder} value={folder}>{folder}</option>)}
          </select>
        </label>
        <label>
          Run as
          <select name="runAs" defaultValue="user">
            <option value="user">SSH user</option>
            <option value="root" disabled={!rootAccess}>root{rootAccess ? "" : " (not enabled)"}</option>
          </select>
          <small>Root scripts must be created inside a folder approved by the server helper.</small>
        </label>
        <label>
          Script content
          <textarea name="content" required spellCheck={false} defaultValue={'#!/usr/bin/env bash\nset -eu\n\n# Add commands here\n'} />
          <small>The script runs as the dashboard SSH user. It is saved as an executable file inside the selected allowed folder.</small>
        </label>
        {error && <div className="alert">{error}</div>}
        <Btn className="primary">Create script</Btn>
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
    [showFileBrowser, setShowFileBrowser] = useState(false),
    options = script.runOptions || [];
  const option = options[Number(selected)];
  return (
    <Modal title={`Run ${script.name}`} close={close}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            const result = await api("script/run", { id: script.id, option: selected, file: selectedFile });
            done(script, result.run.id);
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : "Could not start script");
          }
        }}
      >
        <label>
          Choose an option
          <select
            autoFocus
            value={selected}
            onChange={(event) => {
              setSelected(event.target.value);
              setSelectedFile("");
              setShowFileBrowser(false);
            }}
          >
            {options.map((option, index) => (
              <option key={`${option.label}-${index}`} value={index}>{option.label}</option>
            ))}
          </select>
          <small>{option?.description || option?.value}</small>
        </label>
        {option?.needsFile && (
          <section className="run-file-picker">
            <b>Select a file</b>
            <small>The selected path is inserted after <code>--file</code>, before confirmation flags such as <code>--yes</code>.</small>
            {selectedFile && <code>{selectedFile}</code>}
            <Btn type="button" onClick={() => setShowFileBrowser((open) => !open)}>
              <FolderOpen size={16} />
              {selectedFile ? "Change file" : "Choose file"}
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
        <Btn className="primary" disabled={!!option?.needsFile && !selectedFile}>Run script</Btn>
      </form>
    </Modal>
  );
}
export function FolderForm({ close, done }: { close: () => void; done: () => void }) {
  const [error, setError] = useState("");
  return (
    <Modal title="New folder" close={close}>
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
            setError(reason instanceof Error ? reason.message : "Error");
          }
        }}
      >
        <label>
          Folder name
          <input name="name" autoFocus required maxLength={60} />
        </label>
        {error && <div className="alert">{error}</div>}
        <Btn className="primary">Create folder</Btn>
      </form>
    </Modal>
  );
}
