"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client-api";
import { appConfirm, Btn, Panel, Modal } from "@/components/ui";
import type { St } from "@/lib/types";
import {
  KeyRound,
  Trash2,
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
export function ServerSettings() {
  const [settings, setSettings] = useState<{ sshTarget: string; scriptRoot: string; allowedPaths: string[]; remoteLogs: string; metricsRetentionDays: number } | null>(null);
  const [message, setMessage] = useState(""); const [error, setError] = useState("");
  useEffect(() => { void api("settings/server").then(setSettings).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load server settings")); }, []);
  return <Panel title="Server connection" note="The SSH key and known_hosts stay in Docker mounts; this page stores only the connection and permitted paths.">
    {!settings ? <div className="panel-body"><p>{error || "Loading server settings…"}</p></div> : <form className="account-form" onSubmit={async (event) => { event.preventDefault(); setMessage(""); setError(""); try { const result = await api("settings/server", Object.fromEntries(new FormData(event.currentTarget))); setSettings(result.settings); setMessage(`Connection verified: ${result.connection.host}.`); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save settings"); } }}>
      <label>SSH target <input name="sshTarget" defaultValue={settings.sshTarget} placeholder="user@server" spellCheck={false} /><small>Leave empty only when the dashboard runs on the server itself.</small></label>
      <label>Script root <input name="scriptRoot" required defaultValue={settings.scriptRoot} spellCheck={false} /></label>
      <label>Allowed paths <input name="allowedPaths" required defaultValue={settings.allowedPaths.join(", ")} spellCheck={false} /><small>Comma-separated absolute paths. File and script access is limited to these locations.</small></label>
      <label>Remote logs folder <input name="remoteLogs" required defaultValue={settings.remoteLogs} spellCheck={false} /></label>
      <label>Metric retention (days) <input name="metricsRetentionDays" type="number" min="1" max="365" required defaultValue={settings.metricsRetentionDays} /><small>A health sample is recorded every 5 minutes, even while no browser is open. Older samples are removed.</small></label>
      {message && <div className="success">{message}</div>}{error && <div className="alert">{error}</div>}<Btn className="primary">Save and test connection</Btn>
    </form>}
  </Panel>;
}
export function ConfigurationPanel({ refresh }: { refresh: () => Promise<void> }) {
  const [message, setMessage] = useState(""); const [error, setError] = useState("");
  return <Panel title="Dashboard settings backup" note="Exports dashboard scripts, schedules, folders, alerts, and authorized devices. It does not contain server files, Docker data, passwords, SSH keys, or sessions.">
    <div className="panel-body">
      <div className="actions configuration-actions"><Btn onClick={async () => { const data = await api("config/export"); const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "media-dashboard-settings.json"; link.click(); URL.revokeObjectURL(link.href); setMessage("Settings export downloaded."); }}>Export dashboard settings</Btn>
        <label className="button">Restore dashboard settings<input type="file" accept="application/json" hidden onChange={async (event) => { const file = event.target.files?.[0]; if (!file || !await appConfirm("Restore dashboard settings and overwrite scripts, folders, schedules, devices and alerts?", "Restore dashboard settings", "Restore", true)) return; try { await api("config/restore", { payload: await file.text() }); await refresh(); setMessage("Dashboard settings restored."); } catch (reason) { setError(reason instanceof Error ? reason.message : "Restore failed"); } }} /></label></div>
      {message && <div className="success panel-feedback">{message}</div>}{error && <div className="alert panel-feedback">{error}</div>}
    </div>
  </Panel>;
}
export function StorageManager({ paths, close, done }: { paths: string[]; close: () => void; done: () => Promise<void> }) {
  const [error, setError] = useState(""); const [adding, setAdding] = useState(false);
  return <Modal title="Monitored storage" close={close}>
    <p>Choose the mounted folders whose disk usage should appear on the dashboard. You can track as many paths as needed.</p>
    <form onSubmit={async (event) => { event.preventDefault(); const form = event.currentTarget; setError(""); try { setAdding(true); const path = String(new FormData(form).get("path") || ""); await api("storage/add", { path }); form.reset(); await done(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not add path"); } finally { setAdding(false); } }}>
      <label>Absolute folder path<input name="path" placeholder="/mnt/media" required spellCheck={false} /></label><Btn className="primary" disabled={adding}>Add storage path</Btn>
    </form>
    <div className="storage-path-list">{paths.map((path) => <div className="schedule-row" key={path}><div className="grow"><b>{path}</b><small>Monitored storage path</small></div><Btn className="danger" disabled={paths.length < 2} onClick={async () => { if (!await appConfirm(`Stop monitoring ${path}?`, "Remove storage path", "Remove", true)) return; try { await api("storage/remove", { path }); await done(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not remove path"); } }}><Trash2 size={15}/>Remove</Btn></div>)}</div>
    {error && <div className="alert">{error}</div>}<small>At least one path must remain monitored.</small>
  </Modal>;
}
