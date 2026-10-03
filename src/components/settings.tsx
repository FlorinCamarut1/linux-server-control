"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client-api";
import { appConfirm, appPrompt, Btn, Panel, Modal, PreflightList, RowMenu } from "@/components/ui";
import { THEMES, applyTheme, savedTheme, type ThemeId } from "@/lib/theme";
import type { PreflightCheck, St } from "@/lib/types";
import { LANGUAGES, locale, msg, t } from "@/lib/i18n";
import { LanguageSelect } from "@/components/language";
import {
  KeyRound,
  Pencil,
  UserPlus,
  Trash2,
  Bell,
  Plus,
  Send,
} from "lucide-react";
export function PasswordForm() {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  return (
    <Panel
      title={t("Change password")}
      note={t("Update the password used to sign in to this dashboard")}
    >
      <form
        className="account-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setMessage("");
          setError("");
          const form = event.currentTarget;
          const values = Object.fromEntries(new FormData(form)) as Record<
            string,
            string
          >;
          if (values.newPassword !== values.confirmPassword) {
            setError(t("The new passwords do not match."));
            return;
          }
          try {
            await api("account/password", values);
            form.reset();
            setMessage(t("Password changed. Other signed-in sessions were closed."));
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : t("Error"));
          }
        }}
      >
        <label>
          {t("Current password")}
          <input
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
          />
        </label>
        <label>
          {t("New password")}
          <input
            name="newPassword"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
          />
          <small>{t("Use at least 12 characters.")}</small>
        </label>
        <label>
          {t("Confirm new password")}
          <input
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
          />
        </label>
        {error && <div className="alert">{error}</div>}
        {message && <div className="success">{message}</div>}
        <Btn className="primary">{t("Change password")}</Btn>
      </form>
    </Panel>
  );
}
// Older devices stored a preformatted Romanian date; newer ones store ISO 8601.
export function formatCreated(value: string) {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) ? new Date(value).toLocaleString(locale()) : value;
}
export function DevicePanel({ devices, current, revoke, rename, createCode }: { devices: St["devices"]; current?: string; revoke: (id: string) => void; rename: (id: string, name: string) => void; createCode: () => void }) {
  return <Panel title={t("Authorized browsers")} note={t("Revoke access for an unknown device")} extra={<Btn className="primary" onClick={createCode}><KeyRound size={16}/>{t("Generate access code")}</Btn>}>
    {Object.entries(devices).map(([id, device]) => <div className="device-row" key={id}>
      <div className="grow"><b>{device.name}</b><small>{t("Authorized {time}", { time: formatCreated(device.created) })}</small></div>
      {id === current && <span className="badge up">{t("This browser")}</span>}
      <RowMenu label={t("Actions for the browser {name}", { name: device.name })} items={[{
        label: t("Edit"), icon: <Pencil size={15} />,
        onSelect: async () => {
          const name = (await appPrompt(t("Name of this browser:"), device.name, t("Edit browser"), t("Save")))?.trim();
          if (name && name !== device.name) rename(id, name);
        },
      }, {
        label: t("Revoke access"), icon: <Trash2 size={15} />, danger: true,
        onSelect: async () => {
          const consequence = id === current
            ? t("This is the browser you are using: you are signed out at once, and it needs a new access code to sign in again.")
            : t("It is signed out and needs a new access code to sign in again.");
          if (await appConfirm(`${t("Revoke access for “{name}”?", { name: device.name })} ${consequence}`, t("Revoke browser"), t("Revoke"), true)) revoke(id);
        },
      }]} />
    </div>)}
  </Panel>;
}
export function AppearancePanel() {
  const [current, setCurrent] = useState<ThemeId>(() => savedTheme());
  return <Panel title={t("Appearance")} note={t("The theme and language are saved in this browser, so each device can use its own.")}>
    <div className="panel-body appearance-language"><LanguageSelect /></div>
    <div className="theme-grid" role="radiogroup" aria-label={t("Theme")}>
      {THEMES.map((theme) => (
        <button key={theme.id} type="button" role="radio" aria-checked={current === theme.id} className={`theme-option${current === theme.id ? " active" : ""}`} onClick={() => { applyTheme(theme.id); setCurrent(theme.id); }}>
          <span className="theme-swatch" aria-hidden="true">{theme.colors.map((color) => <i key={color} style={{ background: color }} />)}</span>
          {t(theme.name)}
        </button>
      ))}
    </div>
  </Panel>;
}
type ServerConnection = { sshTarget: string; sshPort: number; scriptRoot: string; allowedPaths: string[]; remoteLogs: string; metricsRetentionDays: number };
// The connection form, also offered on the reconnect screen. Saving tests the
// connection first and keeps the previous settings when the server does not
// answer, so a wrong target is never stored.
export function ServerSettingsForm({ saved, children }: { saved?: () => void; children?: React.ReactNode }) {
  const [settings, setSettings] = useState<ServerConnection | null>(null);
  const [message, setMessage] = useState(""); const [error, setError] = useState("");
  useEffect(() => { void api("settings/server").then(setSettings).catch((reason) => setError(reason instanceof Error ? reason.message : t("Could not load server settings"))); }, []);
  if (!settings) return <div className="panel-body"><p>{error || t("Loading server settings…")}</p></div>;
  return <form className="account-form" onSubmit={async (event) => { event.preventDefault(); setMessage(""); setError(""); try { const result = await api("settings/server", Object.fromEntries(new FormData(event.currentTarget))); setSettings(result.settings); setMessage(t("Connection verified: {host}.", { host: result.connection.host })); saved?.(); } catch (reason) { setError(reason instanceof Error ? reason.message : t("Could not save settings")); } }}>
    <label>{t("SSH target")} <input name="sshTarget" defaultValue={settings.sshTarget} placeholder="user@server" spellCheck={false} /><small>{t("Leave empty only when the dashboard runs on the server itself.")}</small></label>
    <label>{t("SSH port")} <input name="sshPort" type="number" min={1} max={65535} required defaultValue={settings.sshPort} /></label>
    <label>{t("Script root")} <input name="scriptRoot" required defaultValue={settings.scriptRoot} spellCheck={false} /></label>
    <label>{t("Allowed paths")} <input name="allowedPaths" required defaultValue={settings.allowedPaths.join(", ")} spellCheck={false} /><small>{t("Comma-separated absolute paths. File and script access is limited to these locations.")}</small></label>
    <label>{t("Remote logs folder")} <input name="remoteLogs" required defaultValue={settings.remoteLogs} spellCheck={false} /></label>
    <label>{t("Metric retention (days)")} <input name="metricsRetentionDays" type="number" min="1" max="365" required defaultValue={settings.metricsRetentionDays} /><small>{t("A health sample is recorded every 5 minutes, even while no browser is open. Older samples are removed.")}</small></label>
    {message && <div className="success">{message}</div>}{error && <div className="alert">{error}</div>}
    <div className="actions"><Btn className="primary">{t("Save and test connection")}</Btn>{children}</div>
  </form>;
}
export function ServerSettings() {
  const [checks, setChecks] = useState<PreflightCheck[] | null>(null); const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  return <Panel title={t("Server connection")} note={t("The SSH key and known_hosts stay in Docker mounts; this page stores only the connection and permitted paths.")}>
    <ServerSettingsForm>
      <Btn type="button" disabled={checking} onClick={async () => { setError(""); setChecking(true); try { setChecks((await api("preflight", undefined, true)).checks); } catch (reason) { setError(reason instanceof Error ? reason.message : t("Could not check the server")); } finally { setChecking(false); } }}>{checking ? t("Checking…") : t("Check server requirements")}</Btn>
    </ServerSettingsForm>
    {error && <div className="panel-body"><div className="alert">{error}</div></div>}
    {checks && <div className="panel-body"><PreflightList checks={checks} /></div>}
  </Panel>;
}
export function ConfigurationPanel({ refresh }: { refresh: () => Promise<void> }) {
  const [message, setMessage] = useState(""); const [error, setError] = useState("");
  return <Panel title={t("Dashboard settings backup")} note={t("Exports dashboard scripts, schedules, folders, alerts, storage paths, the server connection and authorized devices. It does not contain server files, Docker data, accounts, passwords, notification channels, power devices, SSH keys, or sessions.")}>
    <div className="panel-body">
      <div className="actions configuration-actions"><Btn onClick={async () => { setMessage(""); setError(""); const data = await api("config/export"); const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "linux-server-control-settings.json"; link.click(); URL.revokeObjectURL(link.href); setMessage(t("Settings export downloaded.")); }}>{t("Export dashboard settings")}</Btn>
        <label className="button">{t("Restore dashboard settings")}<input type="file" accept="application/json" hidden onChange={async (event) => {
          const input = event.currentTarget, file = input.files?.[0];
          if (!file) return;
          const content = await file.text();
          // Emptied, so that choosing the same file again is noticed.
          input.value = "";
          setMessage(""); setError("");
          if (!await appConfirm(t("Restore dashboard settings and overwrite scripts, folders, schedules, devices, alerts and storage paths?"), t("Restore dashboard settings"), t("Restore"), true)) return;
          try { await api("config/restore", { payload: content }); await refresh(); setMessage(t("Dashboard settings restored.")); } catch (reason) { setError(reason instanceof Error ? reason.message : t("Restore failed")); }
        }} /></label></div>
      {message && <div className="success panel-feedback">{message}</div>}{error && <div className="alert panel-feedback">{error}</div>}
    </div>
  </Panel>;
}
export function StorageManager({ paths, close, done }: { paths: string[]; close: () => void; done: () => Promise<void> }) {
  const [error, setError] = useState(""); const [adding, setAdding] = useState(false);
  return <Modal title={t("Monitored storage")} close={close}><div className="modal-body">
    <p>{t("Choose the mounted folders whose disk usage should appear on the dashboard. You can track as many paths as needed.")}</p>
    <form onSubmit={async (event) => { event.preventDefault(); const form = event.currentTarget; setError(""); try { setAdding(true); const path = String(new FormData(form).get("path") || ""); await api("storage/add", { path }); form.reset(); await done(); } catch (reason) { setError(reason instanceof Error ? reason.message : t("Could not add path")); } finally { setAdding(false); } }}>
      <label>{t("Absolute folder path")}<input name="path" placeholder="/mnt/media" required spellCheck={false} /></label><Btn className="primary" disabled={adding}>{t("Add storage path")}</Btn>
    </form>
    <div className="storage-path-list">{paths.map((path) => <div className="schedule-row" key={path}><div className="grow"><b>{path}</b><small>{t("Monitored storage path")}</small></div><RowMenu label={t("Actions for {name}", { name: path })} items={[{
      label: t("Edit"), icon: <Pencil size={15} />,
      onSelect: async () => {
        const changed = (await appPrompt(t("Absolute folder path:"), path, t("Edit storage path"), t("Save")))?.trim();
        if (!changed || changed === path) return;
        setError("");
        // The new path is added first, so a wrong one leaves the old in place.
        try { await api("storage/add", { path: changed }); await api("storage/remove", { path }); await done(); }
        catch (reason) { setError(reason instanceof Error ? reason.message : t("Could not change path")); }
      },
    }, {
      label: t("Remove"), icon: <Trash2 size={15} />, danger: true, disabled: paths.length < 2,
      onSelect: async () => { if (!await appConfirm(t("Stop monitoring {path}?", { path }), t("Remove storage path"), t("Remove"), true)) return; try { await api("storage/remove", { path }); await done(); } catch (reason) { setError(reason instanceof Error ? reason.message : t("Could not remove path")); } },
    }]} /></div>)}</div>
    {error && <div className="alert">{error}</div>}<small>{t("At least one path must remain monitored.")}</small>
  </div></Modal>;
}

type ChannelType = { id: string; name: string; placeholder: string; help: string };
type Channel = { id: string; name: string; type: string; url: string; events: string[]; enabled: boolean; lastSentAt?: number; lastError?: string };
type NotificationData = { channels: Channel[]; types: ChannelType[]; events: Record<string, string>; language: string };
const TEST_SENT = "sent";
// Webhooks that receive alerts, failed runs and power device changes.
export function NotificationsPanel() {
  const [data, setData] = useState<NotificationData | null>(null);
  const [editing, setEditing] = useState<Channel | null | undefined>();
  const [status, setStatus] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const load = () => api("notifications", undefined, true).then(setData).catch((reason) => setError(reason instanceof Error ? reason.message : t("Could not load notification channels")));
  useEffect(() => { void load(); }, []);
  return <Panel title={t("Notifications")} note={t("Send alerts, failed runs and power device changes to Discord, Slack, ntfy or any webhook.")} extra={<Btn className="primary" onClick={() => setEditing(null)} disabled={!data}><Plus size={16} />{t("Add channel")}</Btn>}>
    {error && <div className="panel-body"><div className="alert">{error}</div></div>}
    {data && <div className="panel-body notification-language"><label>{t("Language of notifications")}<select value={data.language} onChange={async (event) => { const language = event.target.value; setError(""); try { await api("notifications/language", { language }); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : t("Error")); } }}>{LANGUAGES.map((item) => <option key={item.id} value={item.id} lang={item.id}>{item.name}</option>)}</select><small>{t("For every channel, and for alerts the server finds on its own.")}</small></label></div>}
    {data && !data.channels.length && <div className="empty-state"><Bell size={22} /><b>{t("No notification channels")}</b><p>{t("Add a webhook to be told when an alert triggers or a run fails.")}</p></div>}
    {data?.channels.map((channel) => (
      <div className="schedule-row" key={channel.id}>
        <span className="service-icon"><Bell size={18} /></span>
        <div className="grow">
          <b>{channel.name}</b>
          <small>{data.types.find((type) => type.id === channel.type)?.name ?? channel.type} · {channel.url} · {t("{count} of {total} events", { count: channel.events.length, total: Object.keys(data.events).length })}</small>
          {(status[channel.id] || channel.lastError) && <small className={status[channel.id] === TEST_SENT ? "notice-ok" : "notice-error"}>{status[channel.id] === TEST_SENT ? t("Test sent.") : status[channel.id] || t("Last delivery failed: {error}", { error: channel.lastError ?? "" })}</small>}
        </div>
        {!channel.enabled && <span className="badge root">{t("Paused")}</span>}
        <RowMenu label={t("Actions for the channel {name}", { name: channel.name })} items={[
          {
            label: t("Send test"), icon: <Send size={15} />,
            onSelect: async () => {
              setStatus((current) => ({ ...current, [channel.id]: t("Sending…") }));
              try { await api("notifications/test", { id: channel.id }); setStatus((current) => ({ ...current, [channel.id]: TEST_SENT })); }
              catch (reason) { setStatus((current) => ({ ...current, [channel.id]: reason instanceof Error ? reason.message : t("The test failed") })); }
            },
          },
          { label: t("Edit"), icon: <Pencil size={15} />, onSelect: () => setEditing(channel) },
          {
            label: t("Delete"), icon: <Trash2 size={15} />, danger: true,
            onSelect: async () => {
              if (!await appConfirm(t("Delete the notification channel {name}?", { name: channel.name }), t("Delete channel"), t("Delete"), true)) return;
              try { await api("notifications/delete", { id: channel.id }); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : t("Could not delete the channel")); }
            },
          },
        ]} />
      </div>
    ))}
    {editing !== undefined && data && <ChannelForm channel={editing} data={data} close={() => setEditing(undefined)} saved={async () => { setEditing(undefined); await load(); }} />}
  </Panel>;
}
function ChannelForm({ channel, data, close, saved }: { channel: Channel | null; data: NotificationData; close: () => void; saved: () => void }) {
  const [type, setType] = useState(channel?.type ?? data.types[0].id);
  const [error, setError] = useState("");
  const info = data.types.find((item) => item.id === type);
  return <Modal title={channel ? t("Edit {name}", { name: channel.name }) : t("Add notification channel")} close={close}>
    <form onSubmit={async (event) => {
      event.preventDefault(); setError("");
      const form = new FormData(event.currentTarget);
      try {
        await api("notifications/save", { id: channel?.id, type, name: form.get("name"), url: form.get("url"), events: form.getAll("events"), enabled: form.get("enabled") === "true" });
        saved();
      } catch (reason) { setError(reason instanceof Error ? reason.message : t("Could not save the channel")); }
    }}>
      <label>{t("Service")}<select value={type} onChange={(event) => setType(event.target.value)} disabled={!!channel}>{data.types.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>{t("Name")}<input name="name" defaultValue={channel?.name} required maxLength={60} placeholder={t("Server alerts")} /></label>
      <label>{t("Webhook URL")}<input name="url" type="url" required={!channel} spellCheck={false} autoComplete="off" placeholder={channel ? t("Leave blank to keep the saved URL ({url})", { url: channel.url }) : info?.placeholder} />{info && <small>{info.help}</small>}</label>
      <fieldset className="event-choices">
        <legend>{t("Send these events")}</legend>
        {Object.entries(data.events).map(([id, label]) => (
          <label key={id}><input type="checkbox" name="events" value={id} defaultChecked={channel ? channel.events.includes(id) : true} /> {label}</label>
        ))}
      </fieldset>
      <label><input name="enabled" type="checkbox" value="true" defaultChecked={channel?.enabled !== false} /> {t("Enabled")}</label>
      {error && <div className="alert">{error}</div>}
      <Btn className="primary">{channel ? t("Save channel") : t("Add channel")}</Btn>
    </form>
  </Modal>;
}

type Account = { username: string; role: "admin" | "viewer"; owner: boolean; created?: string };
const ROLE_LABELS = { admin: msg("Administrator"), viewer: msg("Read-only") };
// Accounts besides the owner: administrators, and read-only accounts that can
// see status, history and logs but change nothing.
export function UsersPanel({ current }: { current: string }) {
  const [users, setUsers] = useState<Account[] | null>(null);
  const [editing, setEditing] = useState<Account | null | undefined>();
  const [error, setError] = useState("");
  const load = () => api("users", undefined, true).then((data) => setUsers(data.users)).catch((reason) => setError(reason instanceof Error ? reason.message : t("Could not load accounts")));
  useEffect(() => { void load(); }, []);
  return <Panel title={t("Accounts")} note={t("Administrators can change everything. Read-only accounts see status, history and logs, and cannot change anything.")} extra={<Btn className="primary" onClick={() => setEditing(null)} disabled={!users}><UserPlus size={16} />{t("Add account")}</Btn>}>
    {error && <div className="panel-body"><div className="alert">{error}</div></div>}
    {users?.map((user) => (
      <div className="device-row" key={user.username}>
        <div className="grow">
          <b>{user.username}{user.username === current ? ` (${t("you")})` : ""}</b>
          <small>{user.owner ? t("Owner, created at setup") : user.created ? t("Created {time}", { time: formatCreated(user.created) }) : ""}</small>
        </div>
        <span className={`badge ${user.role === "admin" ? "up" : "root"}`}>{t(ROLE_LABELS[user.role])}</span>
        {/* The owner has no menu; the space keeps the badges in one column. */}
        {user.owner && <span className="menu-spacer" aria-hidden="true" />}
        {!user.owner && <RowMenu label={t("Actions for the account {name}", { name: user.username })} items={[
          { label: t("Edit"), icon: <Pencil size={15} />, onSelect: () => setEditing(user) },
          user.username !== current && {
            label: t("Delete"), icon: <Trash2 size={15} />, danger: true,
            onSelect: async () => {
              if (!await appConfirm(t("Delete the account {name}? It is signed out everywhere.", { name: user.username }), t("Delete account"), t("Delete"), true)) return;
              try { await api("users/delete", { username: user.username }); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : t("Could not delete the account")); }
            },
          },
        ]} />}
      </div>
    ))}
    {editing !== undefined && <AccountForm account={editing} self={editing?.username === current} close={() => setEditing(undefined)} saved={async () => { setEditing(undefined); await load(); }} />}
  </Panel>;
}
function AccountForm({ account, self, close, saved }: { account: Account | null; self: boolean; close: () => void; saved: () => void }) {
  const [error, setError] = useState("");
  return <Modal title={account ? t("Edit {name}", { name: account.username }) : t("Add account")} close={close}>
    <form onSubmit={async (event) => {
      event.preventDefault(); setError("");
      const values = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
      try { await api("users/save", { ...values, username: account?.username ?? values.username, role: self ? account!.role : values.role }); saved(); }
      catch (reason) { setError(reason instanceof Error ? reason.message : t("Could not save the account")); }
    }}>
      {!account && <label>{t("Username")}<input name="username" required maxLength={40} pattern="[a-zA-Z0-9_.\-]+" autoComplete="off" spellCheck={false} /></label>}
      <label>{t("Role")}<select name="role" defaultValue={account?.role ?? "viewer"} disabled={self}><option value="viewer">{t("Read-only")}</option><option value="admin">{t("Administrator")}</option></select>{self && <small>{t("You cannot change your own role.")}</small>}</label>
      <label>{t("Password")}<input name="password" type="password" minLength={12} required={!account} autoComplete="new-password" placeholder={account ? t("Leave blank to keep the current password") : ""} /><small>{t("At least 12 characters. A new browser also needs an access code the first time it signs in.")}</small></label>
      {error && <div className="alert">{error}</div>}
      <Btn className="primary">{account ? t("Save account") : t("Add account")}</Btn>
    </form>
  </Modal>;
}
