"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client-api";
import { appConfirm, appPrompt, Btn, copyText, Panel, formatBytes, Modal, ModalActions, notify, PAGE_REFRESH, RowMenu, rich } from "@/components/ui";
import { locale, t } from "@/lib/i18n";
import type { ScriptBrowserData, FileBrowserData } from "@/lib/types";
import {
  ClipboardPaste,
  ChevronLeft,
  ChevronRight,
  Copy,
  Eye,
  FileTerminal,
  FilePenLine,
  Folder,
  FolderOpen,
  Info,
  LayoutGrid,
  LayoutList,
  Loader2,
  Scissors,
  Trash2,
  X,
} from "lucide-react";
type Entry = FileBrowserData["entries"][number];
// The server opens text files up to this size in the editor.
const MAX_EDITABLE_BYTES = 512 * 1024;
const editable = (entry: Entry) => entry.type === "file" && (entry.size === null || entry.size <= MAX_EDITABLE_BYTES);
const FILES_PAGE = 100;
function formatModified(modified?: number) {
  return modified ? new Date(modified * 1000).toLocaleString(locale(), { dateStyle: "short", timeStyle: "short" }) : "";
}
// A file picker scrolls into view when it opens below the field that opened it.
const reveal = (node: HTMLElement | null) => node?.scrollIntoView({ block: "nearest" });
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
      // A listing sorted by size arrives with its folder sizes already measured.
      if (includeSizes && result.entries.some((entry: FileBrowserData["entries"][number]) => entry.type === "directory" && entry.size === null)) {
        setSizesLoading(true);
        try {
          const measured = await api("file/sizes", { path: result.path, hidden: requestOptions.hidden }, true);
          if (current === generation.current) {
            const entries = result.entries.map((entry: FileBrowserData["entries"][number]) =>
              entry.type === "directory" ? { ...entry, size: measured.sizes[entry.path] ?? null } : entry);
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
        setError(reason instanceof Error ? reason.message : t("Could not read folder"));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [endpoint, directory, includeSizes, optionsKey]);
  useEffect(() => {
    // The rule cannot see that fetchDirectory only sets state after awaiting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchDirectory();
    // A response that arrives after this request was replaced is dropped.
    const requests = generation;
    return () => { requests.current++; };
  }, [fetchDirectory]);
  const load = useCallback(() => {
    setLoading(true);
    setSizesLoading(false);
    setError("");
    return fetchDirectory();
  }, [fetchDirectory]);
  return { data, error, setError, loading, sizesLoading, load };
}
// Pickers have no paging: they load one large page and say when a folder holds more.
const PICKER_PAGE = { limit: 1000 };
function PickerOverflow({ data }: { data: { entries: unknown[]; total?: number } | null }) {
  if (!data?.total || data.total <= data.entries.length) return null;
  return <div className="file-browser-empty">{t("Showing the first {shown} of {total} items. Use the Files page to reach the rest.", { shown: data.entries.length, total: data.total })}</div>;
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
    // An entry's full name, path, size and date, and why it did not open.
    [details, setDetails] = useState<{ entry: Entry; note?: string } | null>(null),
    [opening, setOpening] = useState(""),
    [search, setSearch] = useState(""), [sort, setSort] = useState("name"), [offset, setOffset] = useState(0),
    // Hidden files (.ssh, .config) are listed only after the sudo password.
    [showHidden, setShowHidden] = useState(false), [askingSudo, setAskingSudo] = useState(false), [hiddenNote, setHiddenNote] = useState(""),
    [clipboard, setClipboard] = useState<{
      path: string;
      action: "copy" | "move";
      name: string;
    } | null>(null);
  const { data, error, loading, sizesLoading, load } = useDirectory<FileBrowserData & { total?: number; offset?: number; limit?: number }>("file/browse", directory, true, { search, sort, offset, limit: FILES_PAGE, hidden: showHidden });
  const listTop = useRef<HTMLDivElement>(null);
  // The page's Refresh button reads the folder again too.
  useEffect(() => {
    const refresh = () => void load();
    window.addEventListener(PAGE_REFRESH, refresh);
    return () => window.removeEventListener(PAGE_REFRESH, refresh);
  }, [load]);
  // After 15 minutes the server stops showing them; the switch follows.
  if (showHidden && data?.hiddenRequested && !data.hidden) {
    setShowHidden(false);
    setHiddenNote(t("Hidden files are hidden again after 15 minutes. Show them again with the sudo password."));
  }
  async function toggleHidden(show: boolean) {
    setHiddenNote("");
    if (show) return setAskingSudo(true);
    setShowHidden(false);
    setOffset(0);
    await api("file/hidden", { show: false }).catch(() => {});
  }
  function navigate(path: string) {
    setOffset(0);
    setDirectory(path);
  }
  function turnPage(next: number) {
    setOffset(next);
    listTop.current?.scrollIntoView({ block: "start" });
  }
  // A failed change is reported at the bottom of the screen; the folder stays listed.
  async function operate(
    action: "delete" | "copy" | "move" | "rename",
    source: string,
    destination = "",
    name = "",
  ) {
    try {
      setOpening(source);
      await api("file/operation", { action, source, destination, name, hidden: showHidden });
      if (action === "move" || action === "delete") setClipboard(null);
      await load();
      return true;
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : t("Could not change file"));
      return false;
    } finally { setOpening(""); }
  }
  async function removeEntry(entry: Entry) {
    const description = entry.type === "directory"
      ? t("Delete folder {path} and ALL its contents? This permanently deletes files from the server.", { path: entry.path })
      : t("Delete file {path}? This cannot be undone.", { path: entry.path });
    if (await appConfirm(description, entry.type === "directory" ? t("Delete folder") : t("Delete file"), t("Delete"), true)) await operate("delete", entry.path);
  }
  async function renameEntry(entry: Entry) {
    const name = (await appPrompt(t("Rename {name} to:", { name: entry.name }), entry.name, t("Rename item"), t("Rename")))?.trim();
    if (name && name !== entry.name) await operate("rename", entry.path, "", name);
  }
  async function paste() {
    if (!clipboard || !data) return;
    if (await operate(clipboard.action, clipboard.path, data.path)) notify(t("Pasted {name}", { name: clipboard.name }), "success");
  }
  // Folders open; text files open in the editor; anything else, and a file the
  // server will not edit, shows its details instead.
  async function openEntry(entry: Entry) {
    if (entry.type === "directory") return navigate(entry.path);
    if (!editable(entry)) return setDetails({ entry, note: t("Only text files up to 512 KB can be edited here") });
    try {
      setOpening(entry.path);
      setEditor(await api("file/read", { path: entry.path, hidden: showHidden }));
    } catch (reason) {
      setDetails({ entry, note: reason instanceof Error ? reason.message : t("Could not open file") });
    } finally {
      setOpening("");
    }
  }
  async function create(kind: "file" | "folder") {
    if (!data) return;
    const name = (kind === "folder" ? await appPrompt(t("Enter the new folder name:"), "", t("New folder"), t("Create folder")) : await appPrompt(t("Enter the new file name:"), "", t("New file"), t("Create file")))?.trim();
    if (!name) return;
    try { setOpening(name); await api("file/create", { path: data.path, name, kind, hidden: showHidden }); await load(); }
    catch (reason) { notify(reason instanceof Error ? reason.message : t("Could not create item")); }
    finally { setOpening(""); }
  }
  const copyEntry = (entry: Entry) => setClipboard({ path: entry.path, action: "copy", name: entry.name });
  const cutEntry = (entry: Entry) => setClipboard({ path: entry.path, action: "move", name: entry.name });
  // The current folder as links, from its allowed location down.
  const root = currentLocation(data, directory);
  const crumbs = data && root && (data.path === root || data.path.startsWith(root + "/"))
    ? [root, ...data.path.slice(root.length).split("/").filter(Boolean)].map((name, index, names) => ({
      name,
      path: index ? [root, ...names.slice(1, index + 1)].join("/") : root,
    }))
    : [];
  const total = data?.total ?? 0;
  const pager = !loading && !error && total > FILES_PAGE && (
    <div className="actions file-pager">
      <Btn disabled={!offset} onClick={() => turnPage(Math.max(0, offset - FILES_PAGE))}><ChevronLeft size={16} />{t("Previous")}</Btn>
      <small>{t("{from}–{to} of {total}", { from: offset + 1, to: Math.min(offset + FILES_PAGE, total), total })}</small>
      <Btn disabled={offset + FILES_PAGE >= total} onClick={() => turnPage(offset + FILES_PAGE)}>{t("Next")}<ChevronRight size={16} /></Btn>
    </div>
  );
  return (
    <>
      <Panel
        title={t("File explorer")}
        note={t("Browse and edit files inside the allowed folders")}
        extra={
          <div className="actions file-explorer-actions">
            {(data?.roots.length || 0) > 1 && (
              <select className="file-explorer-roots" dir="ltr" aria-label={t("Location")} value={root} onChange={(event) => navigate(event.target.value)}>
                {data?.roots.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            )}
            <div className="file-view-toggle" aria-label={t("File view")}>
              <button
                type="button"
                className={view === "grid" ? "active" : ""}
                aria-label={t("Grid view")}
                aria-pressed={view === "grid"}
                title={t("Grid view")}
                onClick={() => setView("grid")}
              >
                <LayoutGrid size={16} />
              </button>
              <button
                type="button"
                className={view === "list" ? "active" : ""}
                aria-label={t("List view")}
                aria-pressed={view === "list"}
                title={t("List view")}
                onClick={() => setView("list")}
              >
                <LayoutList size={16} />
              </button>
            </div>
            <Btn disabled={!data || !!opening} onClick={() => create("folder")}><Folder size={16} />{t("New folder")}</Btn>
            <Btn disabled={!data || !!opening} onClick={() => create("file")}><FileTerminal size={16} />{t("New file")}</Btn>
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
            aria-label={t("Folder path")}
            key={data?.path}
            // The end of a long path, the current folder, is what is in view.
            ref={(input) => { if (input) input.scrollLeft = input.scrollWidth; }}
            name="path"
            defaultValue={data?.path || ""}
            placeholder={t("/home/folder or /mnt/folder")}
            spellCheck={false}
          />
          <Btn disabled={loading}>{t("Go")}</Btn>
        </form>
        <div className="file-explorer-tools">
          <input type="search" aria-label={t("Search files")} value={search} onChange={(event) => { setSearch(event.target.value); setOffset(0); }} placeholder={t("Search this folder")} />
          <select aria-label={t("Sort files")} value={sort} onChange={(event) => { setSort(event.target.value); setOffset(0); }}>
            <option value="name">{t("Sort by name")}</option>
            <option value="size">{t("Sort by size")}</option>
            <option value="date">{t("Sort by date")}</option>
          </select>
          <label className="file-hidden-toggle">
            <input type="checkbox" checked={showHidden} onChange={(event) => void toggleHidden(event.target.checked)} />
            {t("Show hidden files")}
          </label>
          <small>{t("Folder sizes are calculated on demand.")}</small>
        </div>
        {hiddenNote && <div className="alert">{hiddenNote}</div>}
        <div className="file-explorer-nav" ref={listTop}>
          {data?.parent && (
            <button type="button" className="file-explorer-up" aria-label={t("Up one folder")} onClick={() => navigate(data.parent!)}>
              <ChevronLeft size={18} /> {t("Up")}
            </button>
          )}
          {crumbs.length > 0 && (
            <nav className="file-crumbs" aria-label={t("Current folder")} key={data?.path} ref={(element) => { if (element) element.scrollLeft = element.scrollWidth * (document.dir === "rtl" ? -1 : 1); }}>
              {crumbs.map((crumb, index) => index === crumbs.length - 1
                ? <b key={crumb.path} aria-current="location" dir="auto">{crumb.name}</b>
                : <span key={crumb.path}><button type="button" dir="auto" onClick={() => navigate(crumb.path)}>{crumb.name}</button><ChevronRight size={14} aria-hidden="true" /></span>)}
            </nav>
          )}
        </div>
        {pager}
        {loading && !error && <div className="empty-state"><Loader2 className="spin" /><b>{t("Loading files…")}</b></div>}
        {error && <div className="alert file-explorer-error">{error}</div>}
        {!loading && !error && data?.entries.length ? (
          <div className={`file-explorer-grid ${view}`}>
          {data.entries.map((entry) => (
          <article className={`file-explorer-card ${entry.type}`} key={entry.path}>
            <button
              type="button"
              className="file-explorer-open"
              aria-busy={opening === entry.path}
              onClick={() => void openEntry(entry)}
            >
              {opening === entry.path ? <Loader2 className="spin" size={20} /> : entry.type === "directory" ? <Folder size={34} /> : <FileTerminal size={30} />}
              <span className="file-name" dir="auto" title={entry.name}>{entry.name}</span>
              <small className="file-meta">
                {entry.size === null
                  ? (sizesLoading ? t("Calculating size…") : t("Size unavailable"))
                  : formatBytes(entry.size)}
                {entry.modified ? <> · <time dateTime={new Date(entry.modified * 1000).toISOString()}>{formatModified(entry.modified)}</time></> : null}
              </small>
            </button>
            <div className="file-explorer-menu">
              <RowMenu
                label={t("Actions for {name}", { name: entry.name })}
                disabled={!!opening}
                items={[
                  { label: t("Details"), icon: <Info size={15} />, onSelect: () => setDetails({ entry }) },
                  editable(entry) && { label: t("Edit"), icon: <FilePenLine size={15} />, onSelect: () => void openEntry(entry) },
                  { label: t("Copy"), icon: <Copy size={15} />, onSelect: () => copyEntry(entry) },
                  { label: t("Cut"), icon: <Scissors size={15} />, onSelect: () => cutEntry(entry) },
                  { label: t("Rename"), icon: <FilePenLine size={15} />, onSelect: () => renameEntry(entry) },
                  { label: t("Delete"), icon: <Trash2 size={15} />, danger: true, onSelect: () => removeEntry(entry) },
                ]}
              />
            </div>
          </article>
          ))}
          </div>
        ) : null}
        {!loading && !error && data && !data.entries.length && <div className="empty-state"><Folder size={22} /><b>{search ? t("Nothing matches “{search}”", { search }) : t("This folder is empty")}</b></div>}
        {pager}
      </Panel>
      {clipboard && (
        <div className="clipboard-bar" role="status">
          {clipboard.action === "copy" ? <Copy size={18} /> : <Scissors size={18} />}
          <span><b>{clipboard.action === "copy" ? t("Copied") : t("Cut")}</b> <span dir="auto">{clipboard.name}</span></span>
          <Btn className="primary" disabled={!data || !!opening} onClick={paste}><ClipboardPaste size={16} />{t("Paste here")}</Btn>
          <Btn aria-label={t("Cancel")} title={t("Cancel")} onClick={() => setClipboard(null)}><X size={16} /></Btn>
        </div>
      )}
      {details && (
        <FileDetails
          entry={details.entry}
          note={details.note}
          close={() => setDetails(null)}
          act={(action) => {
            const { entry } = details;
            setDetails(null);
            if (action === "open") void openEntry(entry);
            if (action === "copy") copyEntry(entry);
            if (action === "cut") cutEntry(entry);
            if (action === "rename") void renameEntry(entry);
            if (action === "delete") void removeEntry(entry);
          }}
        />
      )}
      {askingSudo && (
        <SudoPassword
          close={() => setAskingSudo(false)}
          shown={() => {
            setAskingSudo(false);
            setOffset(0);
            setShowHidden(true);
          }}
        />
      )}
      {editor && (
        <FileEditor
          file={editor}
          hidden={showHidden}
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
// Everything about one file or folder, readable however long its name: the
// full name and path, size and date, and what can be done with it.
function FileDetails({ entry, note, close, act }: { entry: Entry; note?: string; close: () => void; act: (action: "open" | "copy" | "cut" | "rename" | "delete") => void }) {
  const folder = entry.type === "directory";
  return (
    <Modal title={folder ? t("Folder details") : t("File details")} close={close}>
      <div className="modal-body file-details">
        <p className="file-details-name" dir="auto">{entry.name}</p>
        {note && <div className="notice">{note}</div>}
        <dl>
          <div><dt>{t("Location")}</dt><dd><code>{entry.path}</code></dd></div>
          <div><dt>{t("Size")}</dt><dd>{entry.size === null ? t("Size unavailable") : formatBytes(entry.size)}</dd></div>
          {entry.modified ? <div><dt>{t("Modified")}</dt><dd>{formatModified(entry.modified)}</dd></div> : null}
        </dl>
        <div className="actions file-details-actions">
          {(folder || editable(entry)) && !note && (
            <Btn className="primary" onClick={() => act("open")}>{folder ? <FolderOpen size={16} /> : <FilePenLine size={16} />}{folder ? t("Open") : t("Edit")}</Btn>
          )}
          <Btn onClick={async () => { if (await copyText(entry.path)) notify(t("Path copied"), "success"); }}><Copy size={16} />{t("Copy path")}</Btn>
          <Btn onClick={() => act("copy")}><Copy size={16} />{t("Copy")}</Btn>
          <Btn onClick={() => act("cut")}><Scissors size={16} />{t("Cut")}</Btn>
          <Btn onClick={() => act("rename")}><FilePenLine size={16} />{t("Rename")}</Btn>
          <Btn className="danger" onClick={() => act("delete")}><Trash2 size={16} />{t("Delete")}</Btn>
        </div>
      </div>
    </Modal>
  );
}
// Asks for the SSH user's sudo password, which the server checks, before
// hidden files are shown for 15 minutes.
function SudoPassword({ close, shown }: { close: () => void; shown: () => void }) {
  const [password, setPassword] = useState(""), [error, setError] = useState(""), [checking, setChecking] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      setChecking(true);
      setError("");
      await api("file/hidden", { show: true, password });
      shown();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("Could not check the password"));
    } finally {
      setChecking(false);
    }
  }
  return (
    <Modal title={t("Show hidden files")} close={close}>
      <form onSubmit={submit}>
        <p>{rich(t("Hidden files, such as {example}, hold keys and settings. Enter the server account's sudo password to show them for 15 minutes."), { example: <code>.ssh</code> })}</p>
        <label>
          {t("Sudo password")}
          <input type="password" autoComplete="off" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        {error && <div className="alert">{error}</div>}
        <ModalActions cancel={close}>
          <Btn className="primary" disabled={checking || !password}>
            {checking ? <Loader2 className="spin" size={15} /> : <Eye size={15} />} {t("Show hidden files")}
          </Btn>
        </ModalActions>
      </form>
    </Modal>
  );
}
export function FileEditor({
  file,
  close,
  changed,
  hidden = false,
}: {
  file: { path: string; content: string };
  close: () => void;
  changed: () => void;
  hidden?: boolean;
}) {
  const [content, setContent] = useState(file.content),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  // Closing by a stray click outside the editor, or by Escape, must not lose edits.
  async function closeEditor() {
    if (content === file.content || await appConfirm(t("Close the editor and discard the changes you have not saved?"), t("Unsaved changes"), t("Discard changes"), true)) close();
  }
  async function saveFile() {
    try {
      setSaving(true);
      await api("file/save", { path: file.path, content, hidden });
      changed();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("Could not save file"));
    } finally {
      setSaving(false);
    }
  }
  async function deleteFile() {
    if (!await appConfirm(t("Delete file {path}? This cannot be undone.", { path: file.path }), t("Delete file"), t("Delete"), true)) return;
    try {
      setSaving(true);
      await api("file/operation", { action: "delete", source: file.path, hidden });
      changed();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("Could not delete file"));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal title={t("Edit file")} close={closeEditor}>
      <div className="file-editor">
        <code>{file.path}</code>
        <textarea aria-label={t("File content")} value={content} onChange={(event) => setContent(event.target.value)} spellCheck={false} />
        {error && <div className="alert">{error}</div>}
        <div className="actions">
          <Btn className="primary" disabled={saving} onClick={saveFile}>
            {saving ? <Loader2 className="spin" size={15} /> : null} {t("Save changes")}
          </Btn>
          <RowMenu label={t("More actions for this file")} disabled={saving} items={[{ label: t("Delete file"), icon: <Trash2 size={15} />, danger: true, onSelect: deleteFile }]} />
        </div>
      </div>
    </Modal>
  );
}
export function FileBrowser({ choose }: { choose: (path: string) => void }) {
  const [directory, setDirectory] = useState("");
  const { data, error, loading } = useDirectory<FileBrowserData>("file/browse", directory, false, PICKER_PAGE);
  return (
    <section className="file-browser" ref={reveal} aria-label={t("File browser")}>
      <div className="file-browser-head">
        <div><b>{t("Choose a file")}</b><small className="path">{data?.path || t("Loading folder…")}</small></div>
        {(data?.roots.length || 0) > 1 && (
          <select className="file-browser-roots" dir="ltr" aria-label={t("Location")} value={currentLocation(data, directory)} onChange={(event) => setDirectory(event.target.value)}>
            {data?.roots.map((root) => <option key={root} value={root}>{root}</option>)}
          </select>
        )}
        <Btn type="button" disabled={!data?.parent} onClick={() => data?.parent && setDirectory(data.parent)}><ChevronLeft size={16} />{t("Up")}</Btn>
      </div>
      <div className="file-browser-list">
        {loading && !error && <div className="file-browser-empty"><Loader2 className="spin" size={18} /> {t("Loading files…")}</div>}
        {error && <div className="file-browser-empty">{error}</div>}
        {!loading && !error && data?.entries.map((entry) => (
          <button key={entry.path} type="button" className="file-browser-row" onClick={() => entry.type === "directory" ? setDirectory(entry.path) : choose(entry.path)}>
            {entry.type === "directory" ? <Folder size={17} /> : <FileTerminal size={17} />}
            <span dir="auto">{entry.name}</span><small>{entry.type === "directory" ? t("Folder") : t("File")}</small>
          </button>
        ))}
        {!loading && !error && data && !data.entries.length && <div className="file-browser-empty">{t("No folders or files here.")}</div>}
        {!loading && !error && <PickerOverflow data={data} />}
      </div>
    </section>
  );
}
export function DirectoryBrowser({ choose }: { choose: (path: string) => void }) {
  const [directory, setDirectory] = useState("");
  const { data, error, loading } = useDirectory<FileBrowserData>("file/browse", directory, false, PICKER_PAGE);
  return (
    <section className="file-browser" ref={reveal} aria-label={t("Folder browser")}>
      <div className="file-browser-head">
        <div><b>{t("Choose a folder")}</b><small className="path">{data?.path || t("Loading folder…")}</small></div>
        {(data?.roots.length || 0) > 1 && (
          <select className="file-browser-roots" dir="ltr" aria-label={t("Location")} value={currentLocation(data, directory)} onChange={(event) => setDirectory(event.target.value)}>
            {data?.roots.map((root) => <option key={root} value={root}>{root}</option>)}
          </select>
        )}
        <Btn type="button" disabled={!data?.parent} onClick={() => data?.parent && setDirectory(data.parent)}><ChevronLeft size={16} />{t("Up")}</Btn>
      </div>
      <div className="file-browser-list">
        {loading && !error && <div className="file-browser-empty"><Loader2 className="spin" size={18} /> {t("Loading folders…")}</div>}
        {error && <div className="file-browser-empty">{error}</div>}
        {!loading && !error && data?.entries.filter((entry) => entry.type === "directory").map((entry) => (
          <button key={entry.path} type="button" className="file-browser-row" onClick={() => setDirectory(entry.path)}>
            <Folder size={17} /><span dir="auto">{entry.name}</span><small>{t("Folder")}</small>
          </button>
        ))}
        {!loading && !error && <PickerOverflow data={data} />}
      </div>
      <div className="file-browser-footer">
        <small className="path">{data?.path || t("Select a folder")}</small>
        <Btn type="button" className="primary" disabled={!data?.path} onClick={() => data?.path && choose(data.path)}>{t("Use this folder")}</Btn>
      </div>
    </section>
  );
}
export function ScriptBrowser({ choose }: { choose: (path: string) => void }) {
  const [directory, setDirectory] = useState(""),
    [selected, setSelected] = useState<string | null>(null);
  const { data, error, loading } = useDirectory<ScriptBrowserData>("script/browse", directory, false, PICKER_PAGE);
  const [selectionDirectory, setSelectionDirectory] = useState(directory);
  if (selectionDirectory !== directory) {
    setSelectionDirectory(directory);
    setSelected(null);
  }
  return (
    <section className="file-browser" ref={reveal} aria-label={t("Script file browser")}>
      <div className="file-browser-head">
        <div>
          <b>{t("Choose a script")}</b>
          <small className="path">{data?.path || t("Loading folder…")}</small>
        </div>
        {(data?.roots.length || 0) > 1 && (
          <select className="file-browser-roots" dir="ltr" aria-label={t("Location")} value={currentLocation(data, directory)} onChange={(event) => setDirectory(event.target.value)}>
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
          {t("Up")}
        </Btn>
      </div>
      <div className="file-browser-list">
        {loading && !error && <div className="file-browser-empty"><Loader2 className="spin" size={18} /> {t("Loading files…")}</div>}
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
            <span dir="auto">{entry.name}</span>
            <small>{entry.type === "directory" ? t("Folder") : t("Shell script")}</small>
          </button>
        ))}
        {!loading && !error && data && !data.entries.length && <div className="file-browser-empty">{t("No folders or .sh files here.")}</div>}
        {!loading && !error && <PickerOverflow data={data} />}
      </div>
      <div className="file-browser-footer">
        <small>{selected ? selected : t("Select a .sh file to continue.")}</small>
        <Btn
          type="button"
          className="primary"
          disabled={!selected}
          onClick={() => selected && choose(selected)}
        >
          {t("Use selected script")}
        </Btn>
      </div>
    </section>
  );
}
