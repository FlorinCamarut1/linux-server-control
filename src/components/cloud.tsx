"use client";
import { useCallback, useEffect, useState } from "react";
import { Cloud, CloudUpload, Copy, History, Loader2, LogIn, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { api } from "@/lib/client-api";
import { appConfirm, Btn, copyText, formatBytes, Modal, ModalActions, notify, Panel, RowMenu, rich } from "@/components/ui";
import { locale, t, tn } from "@/lib/i18n";

type DestinationType = "onedrive" | "drive" | "protondrive";
type Destination = { id: string; type: DestinationType; name: string; folder: string; enabled: boolean; account?: string; last?: { at: number; ok: boolean; file?: string; bytes?: number; error?: string } };
type Schedule = { enabled: boolean; frequency: "daily" | "weekly"; hour: number; weekday: number; timeZone: string; keep: number };
type CloudData = { destinations: Destination[]; schedule: Schedule; passphraseSet: boolean; running: boolean };
type Backup = { name: string; bytes: number; at: number };
const SERVICES: Record<DestinationType, string> = { onedrive: "OneDrive", drive: "Google Drive", protondrive: "Proton Drive" };
// What to run on one's own computer to let rclone use the account. Google
// Drive is limited to the files rclone itself makes (scope drive.file).
const AUTHORIZE: Record<"onedrive" | "drive", string> = {
  onedrive: 'rclone authorize "onedrive"',
  drive: 'rclone authorize "drive" "eyJzY29wZSI6ImRyaXZlLmZpbGUifQ"',
};
const weekdayName = (day: number) => new Date(Date.UTC(2026, 10, 8 + day)).toLocaleDateString(locale(), { weekday: "long", timeZone: "UTC" });
const when = (at: number) => new Date(at).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" });

// Cloud backup: where to, when, how many to keep, and the passphrase that
// encrypts them. Shown to administrators.
export function CloudBackupPanel() {
  const [data, setData] = useState<CloudData | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState<Destination | null | undefined>();
  const [browsing, setBrowsing] = useState<Destination | null>(null);
  const [backingUp, setBackingUp] = useState<string | null>(null);
  const load = useCallback(() => api("cloud", undefined, true).then(setData).catch((reason) => setError(reason instanceof Error ? reason.message : t("Error"))), []);
  useEffect(() => { void load(); }, [load]);
  async function backUp(destination?: Destination) {
    setBackingUp(destination?.id ?? "all");
    try {
      const { results } = await api("cloud/backup", destination ? { id: destination.id } : {});
      const failed = (results as Destination["last"][]).filter((result) => !result?.ok).length;
      notify(failed ? tn("The backup could not be uploaded to {count} destination|The backup could not be uploaded to {count} destinations", failed) : t("Backup uploaded."), failed ? "error" : "success");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : t("Error"));
    } finally {
      setBackingUp(null);
      await load();
    }
  }
  const ready = !!data?.passphraseSet && !!data.destinations.some((item) => item.enabled);
  return (
    <Panel title={t("Cloud backup")} note={t("Backs up the whole dashboard, encrypted, to OneDrive, Google Drive or Proton Drive, and deletes the oldest backups.")}
      extra={<div className="actions">
        <Btn onClick={() => setAdding(null)} disabled={!data}><Cloud size={16} />{t("Add destination")}</Btn>
        <Btn className="primary" onClick={() => backUp()} disabled={!ready || !!backingUp}><CloudUpload size={16} />{t("Back up now")}</Btn>
      </div>}>
      {error && <div className="panel-body"><div className="alert">{error}</div></div>}
      {data && <ScheduleForm data={data} saved={load} />}
      {data && !data.destinations.length && (
        <div className="empty-state"><Cloud size={22} /><b>{t("No cloud destinations")}</b><p>{t("Add OneDrive, Google Drive or Proton Drive to keep the backups there.")}</p></div>
      )}
      {data?.destinations.map((destination) => (
        <div className="schedule-row" key={destination.id}>
          <span className="service-icon">{backingUp === destination.id ? <Loader2 className="spin" size={18} /> : <Cloud size={18} />}</span>
          <div className="grow">
            <b>{destination.name}</b>
            <small>{[SERVICES[destination.type], destination.account, destination.folder].filter(Boolean).join(" · ")}</small>
            {destination.last && (destination.last.ok
              ? <small className="notice-ok">{t("Last backup {time}, {size}", { time: when(destination.last.at), size: formatBytes(destination.last.bytes ?? 0) })}</small>
              : <small className="notice-error">{t("Last backup failed {time}: {error}", { time: when(destination.last.at), error: destination.last.error ?? "" })}</small>)}
          </div>
          {!destination.enabled && <div className="row-side"><span className="badge neutral">{t("Paused")}</span></div>}
          <RowMenu label={t("Actions for {name}", { name: destination.name })} disabled={!!backingUp} items={[
            { label: t("Back up now"), icon: <CloudUpload size={15} />, onSelect: () => backUp(destination) },
            { label: t("Backups"), icon: <History size={15} />, onSelect: () => setBrowsing(destination) },
            { label: t("Edit"), icon: <Pencil size={15} />, onSelect: () => setAdding(destination) },
            {
              label: t("Delete"), icon: <Trash2 size={15} />, danger: true,
              onSelect: async () => {
                if (!await appConfirm(t("Remove {name} from the dashboard? The backups already there stay in the cloud.", { name: destination.name }), t("Remove destination"), t("Remove"), true)) return;
                try { await api("cloud/destination/delete", { id: destination.id }); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : t("Error")); }
              },
            },
          ]} />
        </div>
      ))}
      {adding !== undefined && <DestinationForm destination={adding} close={() => setAdding(undefined)} saved={async () => { setAdding(undefined); await load(); }} />}
      {browsing && <BackupList destination={browsing} close={() => setBrowsing(null)} />}
    </Panel>
  );
}

function ScheduleForm({ data, saved }: { data: CloudData; saved: () => void }) {
  const [frequency, setFrequency] = useState(data.schedule.frequency);
  const [message, setMessage] = useState(""), [error, setError] = useState("");
  return (
    <form className="panel-body cloud-schedule" onSubmit={async (event) => {
      event.preventDefault(); setMessage(""); setError("");
      const form = new FormData(event.currentTarget), input = event.currentTarget;
      try {
        // The hour is the browser's, in its time zone, which the server keeps.
        await api("cloud/settings", { ...Object.fromEntries(form), enabled: form.get("enabled") === "true", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
        (input.elements.namedItem("passphrase") as HTMLInputElement).value = "";
        setMessage(t("Backup settings saved."));
        saved();
      } catch (reason) { setError(reason instanceof Error ? reason.message : t("Error")); }
    }}>
      {!data.passphraseSet && <div className="alert">{t("Set an encryption passphrase first. Keep it somewhere else too: without it, no backup can be restored.")}</div>}
      <label><input name="enabled" type="checkbox" value="true" defaultChecked={data.schedule.enabled} /> {t("Back up automatically")}</label>
      <div className="form-row">
        <label>{t("How often")}<select name="frequency" value={frequency} onChange={(event) => setFrequency(event.target.value as Schedule["frequency"])}>
          <option value="daily">{t("Every day")}</option><option value="weekly">{t("Every week")}</option>
        </select></label>
        {frequency === "weekly" && <label>{t("Day")}<select name="weekday" defaultValue={data.schedule.weekday}>{[1, 2, 3, 4, 5, 6, 0].map((day) => <option key={day} value={day}>{weekdayName(day)}</option>)}</select></label>}
        {frequency !== "weekly" && <input type="hidden" name="weekday" value={data.schedule.weekday} />}
        <label>{t("At")}<select name="hour" defaultValue={data.schedule.hour}>{Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{`${String(hour).padStart(2, "0")}:00`}</option>)}</select></label>
        <label>{t("Keep the latest")}<input name="keep" type="number" min="1" max="365" defaultValue={data.schedule.keep} required /></label>
      </div>
      <label>{data.passphraseSet ? t("New encryption passphrase") : t("Encryption passphrase")}
        <input name="passphrase" type="password" minLength={12} maxLength={1024} autoComplete="new-password" required={!data.passphraseSet} placeholder={data.passphraseSet ? t("Leave blank to keep the current one") : t("At least 12 characters")} />
        <small>{t("Backups made with an older passphrase still need that one to be restored.")}</small>
      </label>
      {message && <div className="success panel-feedback">{message}</div>}{error && <div className="alert panel-feedback">{error}</div>}
      <div className="actions"><Btn className="primary">{t("Save backup settings")}</Btn></div>
    </form>
  );
}

function DestinationForm({ destination, close, saved }: { destination: Destination | null; close: () => void; saved: () => void }) {
  const [type, setType] = useState<DestinationType>(destination?.type ?? "onedrive");
  const [error, setError] = useState(""), [saving, setSaving] = useState(false), [copied, setCopied] = useState(false);
  // Signing in from the page; `manual` when rclone is run on one's own computer instead.
  const [starting, setStarting] = useState(false), [signInPage, setSignInPage] = useState(""), [manual, setManual] = useState(false);
  const command = type === "protondrive" ? "" : AUTHORIZE[type];
  async function signIn() {
    setError(""); setStarting(true);
    // Opened by the click itself, so that the browser does not block it.
    const tab = window.open("", "_blank");
    try {
      const { url } = await api("cloud/sign-in/start", { type });
      setSignInPage(url);
      if (tab) tab.location.href = url;
    } catch (reason) {
      tab?.close();
      setError(reason instanceof Error ? reason.message : t("Error"));
    } finally { setStarting(false); }
  }
  return (
    <Modal title={destination ? t("Edit {name}", { name: destination.name }) : t("Add cloud destination")} close={close} guard>
      <form onSubmit={async (event) => {
        event.preventDefault(); setError(""); setSaving(true);
        const form = new FormData(event.currentTarget);
        try {
          const fields = { ...Object.fromEntries(form), id: destination?.id, type, enabled: destination ? form.get("enabled") === "true" : true };
          await api(!destination && command && !manual ? "cloud/sign-in/finish" : "cloud/destination/save", fields);
          saved();
        } catch (reason) { setError(reason instanceof Error ? reason.message : t("Error")); } finally { setSaving(false); }
      }}>
        <label>{t("Service")}<select value={type} onChange={(event) => { setType(event.target.value as DestinationType); setSignInPage(""); }} disabled={!!destination}>
          {Object.entries(SERVICES).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select></label>
        <label>{t("Name")}<input name="name" defaultValue={destination?.name ?? SERVICES[type]} key={destination ? "name" : type} required maxLength={60} /></label>
        <label>{t("Folder in the cloud")}<input name="folder" defaultValue={destination?.folder ?? "LinuxServerControl"} required maxLength={200} spellCheck={false} /></label>
        {destination && <label><input name="enabled" type="checkbox" value="true" defaultChecked={destination.enabled} /> {t("Include in automatic backups")}</label>}
        {!destination && command && (
          <div className="cloud-steps">
            {!manual && <ol>
              <li>{t("Sign in and allow access:")}
                <div className="actions"><Btn type="button" className="primary" disabled={starting} onClick={signIn}><LogIn size={15} />{t("Sign in with {service}", { service: SERVICES[type] })}</Btn></div>
                {signInPage && <small>{rich(t("If no tab opened, {link}."), { link: <a href={signInPage} target="_blank" rel="noopener noreferrer">{t("open the sign-in page")}</a> })}</small>}
              </li>
              <li>{t("After you allow access, that tab shows that the page cannot be reached. That is expected: copy the whole address from its address bar.")}</li>
              <li><label>{t("Address of that page")}<input name="address" required spellCheck={false} autoComplete="off" placeholder="http://127.0.0.1:53682/?state=…&code=…" /></label></li>
            </ol>}
            {type === "drive" && <small>{t("The dashboard sees only the files it uploads, not the rest of your Drive.")}</small>}
            <details onToggle={(event) => setManual(event.currentTarget.open)}>
              <summary>{t("Or run rclone on your own computer")}</summary>
              <ol>
                <li>{rich(t("Install rclone on your own computer, from {link}."), { link: <a href="https://rclone.org/downloads/" target="_blank" rel="noopener noreferrer">rclone.org/downloads</a> })}</li>
                <li>{t("Run this command there; a browser opens to sign in and allow access:")}
                  <div className="command-copy"><code>{command}</code><Btn type="button" onClick={async () => setCopied(await copyText(command))}><Copy size={15} />{copied ? t("Copied") : t("Copy")}</Btn></div>
                </li>
                <li>{t("Paste here what rclone printed after signing in.")}</li>
              </ol>
              {manual && <label>{t("Code from rclone")}<textarea name="token" rows={4} required spellCheck={false} autoComplete="off" placeholder='{"access_token":"…","refresh_token":"…"}' /></label>}
            </details>
          </div>
        )}
        {!destination && type === "protondrive" && <>
          <label>{t("Proton account email")}<input name="username" type="email" required autoComplete="off" /></label>
          <label>{t("Password")}<input name="password" type="password" required autoComplete="new-password" /></label>
          <label>{t("Mailbox password (only with two-password mode)")}<input name="mailboxPassword" type="password" autoComplete="new-password" /></label>
          <label>{t("Two-factor code (if it is turned on)")}<input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={12} /></label>
          <small>{t("rclone's Proton Drive support is in beta. The password stays on the server, obscured in rclone's configuration.")}</small>
        </>}
        {error && <div className="alert">{error}</div>}
        <ModalActions cancel={close}><Btn className="primary" disabled={saving}>{saving && <Loader2 className="spin" size={15} />}{destination ? t("Save") : t("Connect")}</Btn></ModalActions>
      </form>
    </Modal>
  );
}

function BackupList({ destination, close }: { destination: Destination; close: () => void }) {
  const [backups, setBackups] = useState<Backup[] | null>(null);
  const [error, setError] = useState(""), [working, setWorking] = useState("");
  const load = useCallback(() => api("cloud/backups", { id: destination.id }, true).then((data) => setBackups(data.backups)).catch((reason) => setError(reason instanceof Error ? reason.message : t("Error"))), [destination.id]);
  useEffect(() => { void load(); }, [load]);
  return (
    <Modal title={t("Backups in {name}", { name: destination.name })} close={close}>
      {error && <div className="alert">{error}</div>}
      {!backups && !error && <div className="empty-state" role="status"><Loader2 className="spin" size={22} /></div>}
      {backups && !backups.length && <div className="empty-state"><History size={22} /><b>{t("No backups here yet")}</b></div>}
      {backups?.map((backup) => (
        <div className="schedule-row" key={backup.name}>
          <div className="grow"><b>{when(backup.at)}</b><small>{formatBytes(backup.bytes)} · {backup.name}</small></div>
          {working === backup.name && <Loader2 className="spin" size={16} />}
          <RowMenu label={t("Actions for {name}", { name: backup.name })} disabled={!!working} items={[
            {
              label: t("Restore"), icon: <RotateCcw size={15} />, danger: true,
              onSelect: async () => {
                if (!await appConfirm(t("Replace everything in the dashboard with this backup from {time}? Scripts, schedules, accounts, alerts and history become as they were then; you may have to sign in again.", { time: when(backup.at) }), t("Restore backup"), t("Restore"), true)) return;
                setWorking(backup.name); setError("");
                try { await api("cloud/restore", { id: destination.id, name: backup.name }); notify(t("Backup restored. The page reloads."), "success"); window.setTimeout(() => window.location.reload(), 1500); }
                catch (reason) { setError(reason instanceof Error ? reason.message : t("Restore failed")); } finally { setWorking(""); }
              },
            },
            {
              label: t("Delete"), icon: <Trash2 size={15} />, danger: true,
              onSelect: async () => {
                if (!await appConfirm(t("Delete the backup from {time} from {name}? It cannot be undone.", { time: when(backup.at), name: destination.name }), t("Delete backup"), t("Delete"), true)) return;
                setWorking(backup.name); setError("");
                try { await api("cloud/backups/delete", { id: destination.id, name: backup.name }); await load(); }
                catch (reason) { setError(reason instanceof Error ? reason.message : t("Error")); } finally { setWorking(""); }
              },
            },
          ]} />
        </div>
      ))}
      <div className="modal-actions"><Btn type="button" onClick={close}>{t("Close")}</Btn></div>
    </Modal>
  );
}
