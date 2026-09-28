"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client-api";
import { appConfirm, appPrompt, Btn, Panel, formatBytes, Modal } from "@/components/ui";
import type { ScriptBrowserData, FileBrowserData } from "@/lib/types";
import {
  ClipboardPaste,
  ChevronLeft,
  Copy,
  FileTerminal,
  FilePenLine,
  Folder,
  LayoutGrid,
  LayoutList,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Scissors,
  Trash2,
} from "lucide-react";
export function useDirectory<T>(endpoint: string, directory: string, includeSizes = false, options: Record<string, unknown> = {}) {
  const optionsKey = JSON.stringify(options);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [sizesLoading, setSizesLoading] = useState(false);
  const generation = useRef(0);
  // Reset while rendering when the request changes, instead of in the effect below.
  const requestKey = [endpoint, directory, includeSizes, optionsKey].join("\n");
  const [shownRequest, setShownRequest] = useState(requestKey);
  if (shownRequest !== requestKey) {
    setShownRequest(requestKey);
    setLoading(true);
    setSizesLoading(false);
    setError("");
  }
  // Only sets state after awaiting, so it can run directly from the effect.
  const fetchDirectory = useCallback(async () => {
    const current = ++generation.current;
    const requestOptions = JSON.parse(optionsKey);
    try {
      const result = await api(endpoint, { path: directory, ...requestOptions }, true);
      if (current !== generation.current) return;
      setData(result);
      setLoading(false);
      if (includeSizes && result.entries.some((entry: FileBrowserData["entries"][number]) => entry.type === "directory")) {
        setSizesLoading(true);
        try {
          const measured = await api("file/sizes", { path: result.path }, true);
          if (current === generation.current) {
            const entries = result.entries.map((entry: FileBrowserData["entries"][number]) =>
              entry.type === "directory" ? { ...entry, size: measured.sizes[entry.path] ?? null } : entry);
            if (requestOptions.sort === "size")
              entries.sort((a: FileBrowserData["entries"][number], b: FileBrowserData["entries"][number]) =>
                (b.size ?? -1) - (a.size ?? -1) || a.name.localeCompare(b.name));
            setData({ ...result, entries });
          }
        } catch {
          // Size failures must not hide an otherwise readable directory.
        } finally {
          if (current === generation.current) setSizesLoading(false);
        }
      }
    } catch (reason) {
      if (current === generation.current)
        setError(reason instanceof Error ? reason.message : "Could not read folder");
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [endpoint, directory, includeSizes, optionsKey]);
  useEffect(() => {
    // The rule cannot see that fetchDirectory only sets state after awaiting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchDirectory();
    return () => { generation.current++; };
  }, [fetchDirectory]);
  const load = useCallback(() => {
    setLoading(true);
    setSizesLoading(false);
    setError("");
    return fetchDirectory();
  }, [fetchDirectory]);
  return { data, error, setError, loading, sizesLoading, load };
}
export function currentLocation(data: FileBrowserData | ScriptBrowserData | null, directory: string) {
  const current = directory || data?.path || "";
  return data?.roots.filter((root) => current === root || current.startsWith(root + "/"))
    .sort((a, b) => b.length - a.length)[0] || data?.roots[0] || "";
}
export function FileExplorer() {
  const [directory, setDirectory] = useState(""),
    [view, setView] = useState<"grid" | "list">("list"),
    [editor, setEditor] = useState<{ path: string; content: string } | null>(null),
    [opening, setOpening] = useState(""),
    [menuPath, setMenuPath] = useState<string | null>(null),
    [search, setSearch] = useState(""), [sort, setSort] = useState("name"), [offset, setOffset] = useState(0),
    [clipboard, setClipboard] = useState<{
      path: string;
      action: "copy" | "move";
      name: string;
    } | null>(null);
  const { data, error, setError, loading, sizesLoading, load } = useDirectory<FileBrowserData & { total?: number; offset?: number; limit?: number }>("file/browse", directory, true, { search, sort, offset, limit: 100 });
  function navigate(path: string) {
    setMenuPath(null);
    setOffset(0);
    setDirectory(path);
  }
  async function operate(
    action: "delete" | "copy" | "move" | "rename",
    source: string,
    destination = "",
    name = "",
  ) {
    try {
      setOpening(source);
      setMenuPath(null);
      await api("file/operation", { action, source, destination, name });
      if (action === "move" || action === "delete") setClipboard(null);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not change file");
    } finally { setOpening(""); }
  }
  async function removeEntry(entry: FileBrowserData["entries"][number]) {
    const description = entry.type === "directory"
      ? `Delete folder ${entry.path} and ALL its contents? This permanently deletes files from the server.`
      : `Delete file ${entry.path}? This cannot be undone.`;
    if (await appConfirm(description, `Delete ${entry.type}`, "Delete", true)) await operate("delete", entry.path);
  }
  async function renameEntry(entry: FileBrowserData["entries"][number]) {
    const name = (await appPrompt(`Rename ${entry.name} to:`, entry.name, "Rename item", "Rename"))?.trim();
    if (name && name !== entry.name) await operate("rename", entry.path, "", name);
  }
  async function paste() {
    if (!clipboard || !data) return;
    await operate(clipboard.action, clipboard.path, data.path);
  }
  async function openFile(path: string) {
    try {
      setOpening(path);
      const result = await api("file/read", { path });
      setEditor(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not open file");
    } finally {
      setOpening("");
    }
  }
  async function create(kind: "file" | "folder") {
    if (!data) return;
    const name = (await appPrompt(`Enter the new ${kind} name:`, "", `New ${kind}`, `Create ${kind}`))?.trim();
    if (!name) return;
    try { setOpening(name); await api("file/create", { path: data.path, name, kind }); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create item"); }
    finally { setOpening(""); }
  }
  return (
    <>
      <Panel
        title="File explorer"
        note="Browse and edit files inside the allowed folders"
        extra={
          <div className="actions">
            {(data?.roots.length || 0) > 1 && (
              <select className="file-explorer-roots" aria-label="Location" value={currentLocation(data, directory)} onChange={(event) => navigate(event.target.value)}>
                {data?.roots.map((root) => <option key={root} value={root}>{root}</option>)}
              </select>
            )}
            <div className="file-view-toggle" aria-label="File view">
              <button
                type="button"
                className={view === "grid" ? "active" : ""}
                aria-label="Grid view"
                aria-pressed={view === "grid"}
                title="Grid view"
                onClick={() => setView("grid")}
              >
                <LayoutGrid size={16} />
              </button>
              <button
                type="button"
                className={view === "list" ? "active" : ""}
                aria-label="List view"
                aria-pressed={view === "list"}
                title="List view"
                onClick={() => setView("list")}
              >
                <LayoutList size={16} />
              </button>
            </div>
            <Btn disabled={!clipboard || !!opening || !data} onClick={paste} title={clipboard ? `Paste ${clipboard.name}` : "Copy or cut a file first"}>
              <ClipboardPaste size={16} />Paste
            </Btn>
            <Btn disabled={!data || !!opening} onClick={() => create("folder")}><Folder size={16} />New folder</Btn>
            <Btn disabled={!data || !!opening} onClick={() => create("file")}><FileTerminal size={16} />New file</Btn>
            <Btn onClick={load}><RefreshCw size={16} />Refresh</Btn>
          </div>
        }
      >
        <form
          className="file-explorer-path"
          onSubmit={(event) => {
            event.preventDefault();
            const requested = String(new FormData(event.currentTarget).get("path") || "").trim();
            if (requested) navigate(requested);
          }}
        >
          <input
            aria-label="Folder path"
            key={data?.path}
            name="path"
            defaultValue={data?.path || ""}
            placeholder="/home/folder or /mnt/folder"
            spellCheck={false}
          />
          <Btn disabled={loading}>Go</Btn>
        </form>
        <div className="file-explorer-tools">
          <input aria-label="Search files" value={search} onChange={(event) => { setSearch(event.target.value); setOffset(0); }} placeholder="Search this folder" />
          <select aria-label="Sort files" value={sort} onChange={(event) => { setSort(event.target.value); setOffset(0); }}><option value="name">Sort by name</option><option value="size">Sort by size</option></select>
          <small>Folder sizes are calculated on demand.</small>
        </div>
        {data?.parent && (
          <button type="button" className="file-explorer-up" onClick={() => navigate(data.parent!)}>
            <ChevronLeft size={16} /> Up one folder
          </button>
        )}
        {loading && !error && <div className="empty-state"><Loader2 className="spin" /><b>Loading files…</b></div>}
        {error && <div className="alert">{error}</div>}
        {!loading && !error && data?.entries.length ? (
          <div className={`file-explorer-grid ${view}`}>
          {data.entries.map((entry) => (
          <article className={`file-explorer-card ${entry.type}`} key={entry.path}>
            <button
              type="button"
              className="file-explorer-open"
              onClick={() => entry.type === "directory" ? navigate(entry.path) : openFile(entry.path)}
            >
              {entry.type === "directory" ? <Folder size={34} /> : <FileTerminal size={30} />}
              <span title={entry.name}>{entry.name}</span>
              <small>
                {entry.size === null
                  ? (sizesLoading ? "Calculating size…" : "Size unavailable")
                  : `${entry.type === "directory" ? "Folder uses" : "File size"}: ${formatBytes(entry.size)}`}
              </small>
            </button>
            <div className="file-explorer-menu">
              <button
                type="button"
                className="file-explorer-menu-trigger"
                aria-label={`Actions for ${entry.name}`}
                aria-expanded={menuPath === entry.path}
                disabled={!!opening}
                onClick={() => setMenuPath((open) => open === entry.path ? null : entry.path)}
              >
                <MoreHorizontal size={18} />
              </button>
              {menuPath === entry.path && (
                <div className="file-explorer-menu-items">
                  {entry.type === "file" && (
                    <button type="button" onClick={() => openFile(entry.path)}>
                      <FilePenLine size={15} /> Edit
                    </button>
                  )}
                  <button type="button" onClick={() => { setClipboard({ path: entry.path, action: "copy", name: entry.name }); setMenuPath(null); }}>
                    <Copy size={15} /> Copy
                  </button>
                  <button type="button" onClick={() => { setClipboard({ path: entry.path, action: "move", name: entry.name }); setMenuPath(null); }}>
                    <Scissors size={15} /> Cut
                  </button>
                  <button type="button" onClick={() => renameEntry(entry)}>
                    <FilePenLine size={15} /> Rename
                  </button>
                  <button type="button" className="danger" onClick={() => removeEntry(entry)}>
                    <Trash2 size={15} /> Delete
                  </button>
                </div>
              )}
            </div>
          </article>
          ))}
          </div>
        ) : null}
        {!loading && !error && data && !data.entries.length && <div className="empty-state"><Folder size={22} /><b>This folder is empty</b></div>}
        {!loading && !error && (data?.total || 0) > (data?.limit || 100) && <div className="actions"><Btn disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 100))}>Previous</Btn><small>{offset + 1}–{Math.min(offset + 100, data!.total!)} of {data!.total}</small><Btn disabled={offset + 100 >= data!.total!} onClick={() => setOffset(offset + 100)}>Next</Btn></div>}
      </Panel>
      {editor && (
        <FileEditor
          file={editor}
          close={() => setEditor(null)}
          changed={async () => {
            setEditor(null);
            await load();
          }}
        />
      )}
    </>
  );
}
export function FileEditor({
  file,
  close,
  changed,
}: {
  file: { path: string; content: string };
  close: () => void;
  changed: () => void;
}) {
  const [content, setContent] = useState(file.content),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  async function saveFile() {
    try {
      setSaving(true);
      await api("file/save", { path: file.path, content });
      changed();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save file");
    } finally {
      setSaving(false);
    }
  }
  async function deleteFile() {
    if (!await appConfirm(`Delete ${file.path}? This cannot be undone.`, "Delete file", "Delete", true)) return;
    try {
      setSaving(true);
      await api("file/operation", { action: "delete", source: file.path });
      changed();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete file");
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal title="Edit file" close={close}>
      <div className="file-editor">
        <code>{file.path}</code>
        <textarea value={content} onChange={(event) => setContent(event.target.value)} spellCheck={false} />
        {error && <div className="alert">{error}</div>}
        <div className="actions">
          <Btn className="primary" disabled={saving} onClick={saveFile}>
            {saving ? <Loader2 className="spin" size={15} /> : null} Save changes
          </Btn>
          <Btn className="danger" disabled={saving} onClick={deleteFile}><Trash2 size={15} />Delete file</Btn>
        </div>
      </div>
    </Modal>
  );
}
export function FileBrowser({ choose }: { choose: (path: string) => void }) {
  const [directory, setDirectory] = useState("");
  const { data, error, loading } = useDirectory<FileBrowserData>("file/browse", directory);
  return (
    <section className="file-browser" aria-label="File browser">
      <div className="file-browser-head">
        <div><b>Choose a file</b><small>{data?.path || "Loading folder…"}</small></div>
        {(data?.roots.length || 0) > 1 && (
          <select className="file-browser-roots" aria-label="Location" value={currentLocation(data, directory)} onChange={(event) => setDirectory(event.target.value)}>
            {data?.roots.map((root) => <option key={root} value={root}>{root}</option>)}
          </select>
        )}
        <Btn type="button" disabled={!data?.parent} onClick={() => data?.parent && setDirectory(data.parent)}><ChevronLeft size={16} />Up</Btn>
      </div>
      <div className="file-browser-list">
        {loading && !error && <div className="file-browser-empty"><Loader2 className="spin" size={18} /> Loading files…</div>}
        {error && <div className="file-browser-empty">{error}</div>}
        {!loading && !error && data?.entries.map((entry) => (
          <button key={entry.path} type="button" className="file-browser-row" onClick={() => entry.type === "directory" ? setDirectory(entry.path) : choose(entry.path)}>
            {entry.type === "directory" ? <Folder size={17} /> : <FileTerminal size={17} />}
            <span>{entry.name}</span><small>{entry.type === "directory" ? "Folder" : "File"}</small>
          </button>
        ))}
        {!loading && !error && data && !data.entries.length && <div className="file-browser-empty">No folders or files here.</div>}
      </div>
    </section>
  );
}
export function DirectoryBrowser({ choose }: { choose: (path: string) => void }) {
  const [directory, setDirectory] = useState("");
  const { data, error, loading } = useDirectory<FileBrowserData>("file/browse", directory);
  return (
    <section className="file-browser" aria-label="Folder browser">
      <div className="file-browser-head">
        <div><b>Choose a folder</b><small>{data?.path || "Loading folderâ€¦"}</small></div>
        {(data?.roots.length || 0) > 1 && (
          <select className="file-browser-roots" aria-label="Location" value={currentLocation(data, directory)} onChange={(event) => setDirectory(event.target.value)}>
            {data?.roots.map((root) => <option key={root} value={root}>{root}</option>)}
          </select>
        )}
        <Btn type="button" disabled={!data?.parent} onClick={() => data?.parent && setDirectory(data.parent)}><ChevronLeft size={16} />Up</Btn>
      </div>
      <div className="file-browser-list">
        {loading && !error && <div className="file-browser-empty"><Loader2 className="spin" size={18} /> Loading foldersâ€¦</div>}
        {error && <div className="file-browser-empty">{error}</div>}
        {!loading && !error && data?.entries.filter((entry) => entry.type === "directory").map((entry) => (
          <button key={entry.path} type="button" className="file-browser-row" onClick={() => setDirectory(entry.path)}>
            <Folder size={17} /><span>{entry.name}</span><small>Folder</small>
          </button>
        ))}
      </div>
      <div className="file-browser-footer">
        <small>{data?.path || "Select a folder"}</small>
        <Btn type="button" className="primary" disabled={!data?.path} onClick={() => data?.path && choose(data.path)}>Use this folder</Btn>
      </div>
    </section>
  );
}
export function ScriptBrowser({ choose }: { choose: (path: string) => void }) {
  const [directory, setDirectory] = useState(""),
    [selected, setSelected] = useState<string | null>(null);
  const { data, error, loading } = useDirectory<ScriptBrowserData>("script/browse", directory);
  const [selectionDirectory, setSelectionDirectory] = useState(directory);
  if (selectionDirectory !== directory) {
    setSelectionDirectory(directory);
    setSelected(null);
  }
  return (
    <section className="file-browser" aria-label="Script file browser">
      <div className="file-browser-head">
        <div>
          <b>Choose a script</b>
          <small>{data?.path || "Loading folder…"}</small>
        </div>
        {(data?.roots.length || 0) > 1 && (
          <select className="file-browser-roots" aria-label="Location" value={currentLocation(data, directory)} onChange={(event) => setDirectory(event.target.value)}>
            {data?.roots.map((root) => <option key={root} value={root}>{root}</option>)}
          </select>
        )}
        <Btn
          type="button"
          disabled={!data?.parent}
          onClick={() => {
            if (data?.parent) {
              setSelected(null);
              setDirectory(data.parent);
            }
          }}
        >
          <ChevronLeft size={16} />
          Up
        </Btn>
      </div>
      <div className="file-browser-list">
        {loading && !error && <div className="file-browser-empty"><Loader2 className="spin" size={18} /> Loading files…</div>}
        {error && <div className="file-browser-empty">{error}</div>}
        {!loading && !error && data?.entries.map((entry) => (
          <button
            key={entry.path}
            type="button"
            className="file-browser-row"
            aria-pressed={entry.type === "script" && selected === entry.path}
            onClick={() => {
              if (entry.type === "directory") {
                setSelected(null);
                setDirectory(entry.path);
              } else setSelected(entry.path);
            }}
          >
            {entry.type === "directory" ? <Folder size={17} /> : <FileTerminal size={17} />}
            <span>{entry.name}</span>
            <small>{entry.type === "directory" ? "Folder" : "Shell script"}</small>
          </button>
        ))}
        {!loading && !error && data && !data.entries.length && <div className="file-browser-empty">No folders or .sh files here.</div>}
      </div>
      <div className="file-browser-footer">
        <small>{selected ? selected : "Select a .sh file to continue."}</small>
        <Btn
          type="button"
          className="primary"
          disabled={!selected}
          onClick={() => selected && choose(selected)}
        >
          Use selected script
        </Btn>
      </div>
    </section>
  );
}
