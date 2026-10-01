"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client-api";
import { appConfirm, Btn, Panel, Modal, PreflightList } from "@/components/ui";
import { THEMES, applyTheme, savedTheme, type ThemeId } from "@/lib/theme";
import type { PreflightCheck, St } from "@/lib/types";
import {
  KeyRound,
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
      title="Change password"
      note="Update the password used to sign in to this dashboard"
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
            setError("The new passwords do not match.");
            return;
          }
          try {
            await api("account/password", values);
            form.reset();
            setMessage(
              "Password changed. Other signed-in sessions were closed.",
            );
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : "Error");
          }
        }}
      >
        <label>
          Current password
          <input
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
          />
        </label>
        <label>
          New password
          <input
            name="newPassword"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
          />
          <small>Use at least 12 characters.</small>
        </label>
        <label>
          Confirm new password
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
        <Btn className="primary">Change password</Btn>
      </form>
    </Panel>
  );
}
// Older devices stored a preformatted Romanian date; newer ones store ISO 8601.
export function formatCreated(value: string) {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) ? new Date(value).toLocaleString() : value;
}
export function DevicePanel({ devices, revoke, createCode }: { devices: St["devices"]; revoke: (id: string) => void; createCode: () => void }) {
  return <Panel title="Authorized browsers" note="Revoke access for an unknown device" extra={<Btn className="primary" onClick={createCode}><KeyRound size={16}/>Generate access code</Btn>}>
    {Object.entries(devices).map(([id, device]) => <div className="device-row" key={id}><div className="grow"><b>{device.name}</b><small>Authorized {formatCreated(device.created)}</small></div><Btn className="danger" onClick={() => revoke(id)}><Trash2 size={15}/>Revoke</Btn></div>)}
  </Panel>;
}
export function AppearancePanel() {
  const [current, setCurrent] = useState<ThemeId>(() => savedTheme());
  return <Panel title="Appearance" note="The theme is saved in this browser, so each device can use its own.">
    <div className="theme-grid" role="radiogroup" aria-label="Theme">
      {THEMES.map((theme) => (
        <button key={theme.id} type="button" role="radio" aria-checked={current === theme.id} className={`theme-option${current === theme.id ? " active" : ""}`} onClick={() => { applyTheme(theme.id); setCurrent(theme.id); }}>
          <span className="theme-swatch" aria-hidden="true">{theme.colors.map((color) => <i key={color} style={{ background: color }} />)}</span>
          {theme.name}
        </button>
      ))}
    </div>
  </Panel>;
}
export function ServerSettings() {
  const [checks, setChecks] = useState<PreflightCheck[] | null>(null); const [checking, setChecking] = useState(false);
  const [settings, setSettings] = useState<{ sshTarget: string; sshPort: number; scriptRoot: string; allowedPaths: string[]; remoteLogs: string; metricsRetentionDays: number } | null>(null);
  const [message, setMessage] = useState(""); const [error, setError] = useState("");
  useEffect(() => { void api("settings/server").then(setSettings).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load server settings")); }, []);
  return <Panel title="Server connection" note="The SSH key and known_hosts stay in Docker mounts; this page stores only the connection and permitted paths.">
    {!settings ? <div className="panel-body"><p>{error || "Loading server settings…"}</p></div> : <form className="account-form" onSubmit={async (event) => { event.preventDefault(); setMessage(""); setError(""); try { const result = await api("settings/server", Object.fromEntries(new FormData(event.currentTarget))); setSettings(result.settings); setMessage(`Connection verified: ${result.connection.host}.`); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save settings"); } }}>
      <label>SSH target <input name="sshTarget" defaultValue={settings.sshTarget} placeholder="user@server" spellCheck={false} /><small>Leave empty only when the dashboard runs on the server itself.</small></label>
      <label>SSH port <input name="sshPort" type="number" min={1} max={65535} required defaultValue={settings.sshPort} /></label>
      <label>Script root <input name="scriptRoot" required defaultValue={settings.scriptRoot} spellCheck={false} /></label>
      <label>Allowed paths <input name="allowedPaths" required defaultValue={settings.allowedPaths.join(", ")} spellCheck={false} /><small>Comma-separated absolute paths. File and script access is limited to these locations.</small></label>
      <label>Remote logs folder <input name="remoteLogs" required defaultValue={settings.remoteLogs} spellCheck={false} /></label>
      <label>Metric retention (days) <input name="metricsRetentionDays" type="number" min="1" max="365" required defaultValue={settings.metricsRetentionDays} /><small>A health sample is recorded every 5 minutes, even while no browser is open. Older samples are removed.</small></label>
      {message && <div className="success">{message}</div>}{error && <div className="alert">{error}</div>}
      <div className="actions"><Btn className="primary">Save and test connection</Btn>
        <Btn type="button" disabled={checking} onClick={async () => { setError(""); setChecking(true); try { setChecks((await api("preflight", undefined, true)).checks); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not check the server"); } finally { setChecking(false); } }}>{checking ? "Checking…" : "Check server requirements"}</Btn></div>
    </form>}
    {checks && <div className="panel-body"><PreflightList checks={checks} /></div>}
  </Panel>;
}
export function ConfigurationPanel({ refresh }: { refresh: () => Promise<void> }) {
  const [message, setMessage] = useState(""); const [error, setError] = useState("");
  return <Panel title="Dashboard settings backup" note="Exports dashboard scripts, schedules, folders, alerts, and authorized devices. It does not contain server files, Docker data, passwords, SSH keys, or sessions.">
    <div className="panel-body">
      <div className="actions configuration-actions"><Btn onClick={async () => { const data = await api("config/export"); const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "linux-server-control-settings.json"; link.click(); URL.revokeObjectURL(link.href); setMessage("Settings export downloaded."); }}>Export dashboard settings</Btn>
        <label className="button">Restore dashboard settings<input type="file" accept="application/json" hidden onChange={async (event) => { const file = event.target.files?.[0]; if (!file || !await appConfirm("Restore dashboard settings and overwrite scripts, folders, schedules, devices and alerts?", "Restore dashboard settings", "Restore", true)) return; try { await api("config/restore", { payload: await file.text() }); await refresh(); setMessage("Dashboard settings restored."); } catch (reason) { setError(reason instanceof Error ? reason.message : "Restore failed"); } }} /></label></div>
      {message && <div className="success panel-feedback">{message}</div>}{error && <div className="alert panel-feedback">{error}</div>}
    </div>
  </Panel>;
}
export function StorageManager({ paths, close, done }: { paths: string[]; close: () => void; done: () => Promise<void> }) {
  const [error, setError] = useState(""); const [adding, setAdding] = useState(false);
  return <Modal title="Monitored storage" close={close}><div className="modal-body">
    <p>Choose the mounted folders whose disk usage should appear on the dashboard. You can track as many paths as needed.</p>
    <form onSubmit={async (event) => { event.preventDefault(); const form = event.currentTarget; setError(""); try { setAdding(true); const path = String(new FormData(form).get("path") || ""); await api("storage/add", { path }); form.reset(); await done(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not add path"); } finally { setAdding(false); } }}>
      <label>Absolute folder path<input name="path" placeholder="/mnt/media" required spellCheck={false} /></label><Btn className="primary" disabled={adding}>Add storage path</Btn>
    </form>
    <div className="storage-path-list">{paths.map((path) => <div className="schedule-row" key={path}><div className="grow"><b>{path}</b><small>Monitored storage path</small></div><Btn className="danger" disabled={paths.length < 2} onClick={async () => { if (!await appConfirm(`Stop monitoring ${path}?`, "Remove storage path", "Remove", true)) return; try { await api("storage/remove", { path }); await done(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not remove path"); } }}><Trash2 size={15}/>Remove</Btn></div>)}</div>
    {error && <div className="alert">{error}</div>}<small>At least one path must remain monitored.</small>
  </div></Modal>;
}

type ChannelType = { id: string; name: string; placeholder: string; help: string };
type Channel = { id: string; name: string; type: string; url: string; events: string[]; enabled: boolean; lastSentAt?: number; lastError?: string };
type NotificationData = { channels: Channel[]; types: ChannelType[]; events: Record<string, string> };
// Webhooks that receive alerts, failed runs and power device changes.
export function NotificationsPanel() {
  const [data, setData] = useState<NotificationData | null>(null);
  const [editing, setEditing] = useState<Channel | null | undefined>();
  const [status, setStatus] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const load = () => api("notifications", undefined, true).then(setData).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load notification channels"));
  useEffect(() => { void load(); }, []);
  return <Panel title="Notifications" note="Send alerts, failed runs and power device changes to Discord, Slack, ntfy or any webhook." extra={<Btn className="primary" onClick={() => setEditing(null)} disabled={!data}><Plus size={16} />Add channel</Btn>}>
    {error && <div className="panel-body"><div className="alert">{error}</div></div>}
    {data && !data.channels.length && <div className="empty-state"><Bell size={22} /><b>No notification channels</b><p>Add a webhook to be told when an alert triggers or a run fails.</p></div>}
    {data?.channels.map((channel) => (
      <div className="schedule-row" key={channel.id}>
        <span className="service-icon"><Bell size={18} /></span>
        <div className="grow">
          <b>{channel.name}</b>
          <small>{data.types.find((type) => type.id === channel.type)?.name ?? channel.type} · {channel.url} · {channel.events.length} of {Object.keys(data.events).length} events</small>
          {(status[channel.id] || channel.lastError) && <small className={status[channel.id] === "Test sent." ? "notice-ok" : "notice-error"}>{status[channel.id] || `Last delivery failed: ${channel.lastError}`}</small>}
        </div>
        {!channel.enabled && <span className="badge root">Paused</span>}
        <div className="actions">
          <Btn onClick={async () => {
            setStatus((current) => ({ ...current, [channel.id]: "Sending…" }));
            try { await api("notifications/test", { id: channel.id }); setStatus((current) => ({ ...current, [channel.id]: "Test sent." })); }
            catch (reason) { setStatus((current) => ({ ...current, [channel.id]: reason instanceof Error ? reason.message : "The test failed" })); }
          }}><Send size={15} />Test</Btn>
          <Btn onClick={() => setEditing(channel)}>Edit</Btn>
          <Btn className="danger" onClick={async () => {
            if (!await appConfirm(`Delete the notification channel ${channel.name}?`, "Delete channel", "Delete", true)) return;
            try { await api("notifications/delete", { id: channel.id }); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not delete the channel"); }
          }}><Trash2 size={15} />Delete</Btn>
        </div>
      </div>
    ))}
    {editing !== undefined && data && <ChannelForm channel={editing} data={data} close={() => setEditing(undefined)} saved={async () => { setEditing(undefined); await load(); }} />}
  </Panel>;
}
function ChannelForm({ channel, data, close, saved }: { channel: Channel | null; data: NotificationData; close: () => void; saved: () => void }) {
  const [type, setType] = useState(channel?.type ?? data.types[0].id);
  const [error, setError] = useState("");
  const info = data.types.find((item) => item.id === type);
  return <Modal title={channel ? `Edit ${channel.name}` : "Add notification channel"} close={close}>
    <form onSubmit={async (event) => {
      event.preventDefault(); setError("");
      const form = new FormData(event.currentTarget);
      try {
        await api("notifications/save", { id: channel?.id, type, name: form.get("name"), url: form.get("url"), events: form.getAll("events"), enabled: form.get("enabled") === "true" });
        saved();
      } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save the channel"); }
    }}>
      <label>Service<select value={type} onChange={(event) => setType(event.target.value)} disabled={!!channel}>{data.types.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Name<input name="name" defaultValue={channel?.name} required maxLength={60} placeholder="Server alerts" /></label>
      <label>Webhook URL<input name="url" type="url" required={!channel} spellCheck={false} autoComplete="off" placeholder={channel ? `Leave blank to keep the saved URL (${channel.url})` : info?.placeholder} />{info && <small>{info.help}</small>}</label>
      <fieldset className="event-choices">
        <legend>Send these events</legend>
        {Object.entries(data.events).map(([id, label]) => (
          <label key={id}><input type="checkbox" name="events" value={id} defaultChecked={channel ? channel.events.includes(id) : true} /> {label}</label>
        ))}
      </fieldset>
      <label><input name="enabled" type="checkbox" value="true" defaultChecked={channel?.enabled !== false} /> Enabled</label>
      {error && <div className="alert">{error}</div>}
      <Btn className="primary">{channel ? "Save channel" : "Add channel"}</Btn>
    </form>
  </Modal>;
}

type Account = { username: string; role: "admin" | "viewer"; owner: boolean; created?: string };
const ROLE_LABELS = { admin: "Administrator", viewer: "Read-only" };
// Accounts besides the owner: administrators, and read-only accounts that can
// see status, history and logs but change nothing.
export function UsersPanel({ current }: { current: string }) {
  const [users, setUsers] = useState<Account[] | null>(null);
  const [editing, setEditing] = useState<Account | null | undefined>();
  const [error, setError] = useState("");
  const load = () => api("users", undefined, true).then((data) => setUsers(data.users)).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load accounts"));
  useEffect(() => { void load(); }, []);
  return <Panel title="Accounts" note="Administrators can change everything. Read-only accounts see status, history and logs, and cannot change anything." extra={<Btn className="primary" onClick={() => setEditing(null)} disabled={!users}><UserPlus size={16} />Add account</Btn>}>
    {error && <div className="panel-body"><div className="alert">{error}</div></div>}
    {users?.map((user) => (
      <div className="device-row" key={user.username}>
        <div className="grow">
          <b>{user.username}{user.username === current ? " (you)" : ""}</b>
          <small>{user.owner ? "Owner, created at setup" : user.created ? `Created ${formatCreated(user.created)}` : ""}</small>
        </div>
        <span className={`badge ${user.role === "admin" ? "up" : "root"}`}>{ROLE_LABELS[user.role]}</span>
        {!user.owner && <div className="actions">
          <Btn onClick={() => setEditing(user)}>Edit</Btn>
          <Btn className="danger" disabled={user.username === current} onClick={async () => {
            if (!await appConfirm(`Delete the account ${user.username}? It is signed out everywhere.`, "Delete account", "Delete", true)) return;
            try { await api("users/delete", { username: user.username }); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not delete the account"); }
          }}><Trash2 size={15} />Delete</Btn>
        </div>}
      </div>
    ))}
    {editing !== undefined && <AccountForm account={editing} self={editing?.username === current} close={() => setEditing(undefined)} saved={async () => { setEditing(undefined); await load(); }} />}
  </Panel>;
}
function AccountForm({ account, self, close, saved }: { account: Account | null; self: boolean; close: () => void; saved: () => void }) {
  const [error, setError] = useState("");
  return <Modal title={account ? `Edit ${account.username}` : "Add account"} close={close}>
    <form onSubmit={async (event) => {
      event.preventDefault(); setError("");
      const values = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
      try { await api("users/save", { ...values, username: account?.username ?? values.username, role: self ? account!.role : values.role }); saved(); }
      catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save the account"); }
    }}>
      {!account && <label>Username<input name="username" required maxLength={40} pattern="[a-zA-Z0-9_.\-]+" autoComplete="off" spellCheck={false} /></label>}
      <label>Role<select name="role" defaultValue={account?.role ?? "viewer"} disabled={self}><option value="viewer">Read-only</option><option value="admin">Administrator</option></select>{self && <small>You cannot change your own role.</small>}</label>
      <label>Password<input name="password" type="password" minLength={12} required={!account} autoComplete="new-password" placeholder={account ? "Leave blank to keep the current password" : ""} /><small>At least 12 characters. A new browser also needs an access code the first time it signs in.</small></label>
      {error && <div className="alert">{error}</div>}
      <Btn className="primary">{account ? "Save account" : "Add account"}</Btn>
    </form>
  </Modal>;
}
