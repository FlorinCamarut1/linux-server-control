"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client-api";
import { ServerSettingsForm } from "@/components/settings";
import { Btn, PreflightList } from "@/components/ui";
import type { PreflightCheck } from "@/lib/types";
import {
  Loader2,
} from "lucide-react";
export function Login({
  error,
  done,
  loading,
}: {
  error: string;
  done: () => void;
  loading: boolean;
}) {
  const [msg, setMsg] = useState(error);
  return (
    <main className="login-wrap">
      <section className="login-card">
        <div className="login-logo">
          <img src="/icon.svg" alt="" />
        </div>
        <h1>Linux Server Control</h1>
        <p>Secure administration for your Linux server.</p>
        {msg && <div className="alert">{msg}</div>}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setMsg("");
            try {
              await api(
                "login",
                Object.fromEntries(new FormData(e.currentTarget)),
              );
              done();
            } catch (x) {
              setMsg(x instanceof Error ? x.message : "Error");
            }
          }}
        >
          <label>
            Username
            <input name="username" autoComplete="username" />
          </label>
          <label>
            Password
            <input name="password" type="password" autoComplete="current-password" />
          </label>
          <details className="enroll">
            <summary>New browser? Enter an enrollment code</summary>
            <label>
              Code
              <input name="code" autoComplete="off" spellCheck={false} />
            </label>
            <label>
              Device name
              <input name="deviceName" />
            </label>
          </details>
          <Btn className="primary full" disabled={loading}>
            {loading && <Loader2 className="spin" size={16} />}
            {loading ? "Signing in…" : "Sign in"}
          </Btn>
        </form>
      </section>
    </main>
  );
}
export function ConnectionUnavailable({ error, retry, signOut, loading }: { error: string; retry: () => void; signOut: () => void; loading: boolean }) {
  // The dashboard cannot open without the server, so Settings is out of reach
  // exactly when the server's address changed. Administrators may therefore
  // correct the connection here; saving it tests it first.
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    void api("state?scope=records", undefined, true).then((data) => setAdmin(data.user?.role === "admin")).catch(() => {});
  }, []);
  return (
    <main className="login-wrap">
      <section className="login-card">
        <div className="login-logo"><img src="/icon.svg" alt="" /></div>
        <h1>Server unavailable</h1>
        <p>Your dashboard session is still valid, but it cannot reach the managed server over SSH.</p>
        <div className="alert">{error}</div>
        <p>Check that the server is online, then verify the SSH target, key, and known_hosts mount.</p>
        <Btn className="primary full" disabled={loading} onClick={retry}>{loading ? "Reconnecting…" : "Reconnect"}</Btn>
        {admin && (
          <details className="enroll reconnect-settings">
            <summary>Change the connection settings</summary>
            <ServerSettingsForm saved={retry} />
          </details>
        )}
        <Btn className="full reconnect-sign-out" onClick={signOut}>Sign out</Btn>
      </section>
    </main>
  );
}
export function Setup({ done, loading }: { done: () => void; loading: boolean }) {
  const [message, setMessage] = useState("");
  const [server, setServer] = useState<{ sshTarget: string; sshPort: number; scriptRoot: string; allowedPaths: string[]; remoteLogs: string } | null>(null);
  const [checks, setChecks] = useState<PreflightCheck[] | null>(null);
  useEffect(() => { void api("setup/status", undefined, true).then((data) => setServer(data.server)).catch(() => {}); }, []);
  // Setup succeeded, but the server lacks something a page needs: say so before continuing.
  if (checks)
    return (
      <main className="login-wrap">
        <section className="login-card">
          <div className="login-logo"><img src="/icon.svg" alt="" /></div>
          <h1>Setup complete</h1>
          <p>The account was created and the server answered. Some features need the items below; you can install them later and check again under Settings → Server connection.</p>
          <PreflightList checks={checks.filter((check) => check.status === "error" || check.status === "warning")} />
          <Btn className="primary full" onClick={done}>Continue to the dashboard</Btn>
        </section>
      </main>
    );
  return (
    <main className="login-wrap">
      <section className="login-card">
        <div className="login-logo"><img src="/icon.svg" alt="" /></div>
        <h1>Set up Linux Server Control</h1>
        <p>Create the administrator account and verify the server connection.</p>
        {message && <div className="alert">{message}</div>}
        <form key={server ? "loaded" : "loading"} onSubmit={async (event) => {
          event.preventDefault();
          try {
            const result = await api("setup", Object.fromEntries(new FormData(event.currentTarget)));
            const found: PreflightCheck[] = result.checks || [];
            if (found.some((check) => check.status === "error" || check.status === "warning")) setChecks(found);
            else done();
          } catch (reason) {
            setMessage(reason instanceof Error ? reason.message : "Setup failed");
          }
        }}>
          <label>Setup token<input name="setupToken" required autoComplete="one-time-code" spellCheck={false} /></label>
          <label>Username<input name="username" defaultValue="admin" required maxLength={40} autoComplete="username" /></label>
          <label>Password<input name="password" type="password" minLength={12} required autoComplete="new-password" /></label>
          <label>Confirm password<input name="confirmPassword" type="password" minLength={12} required autoComplete="new-password" /></label>
          <label>Device name<input name="deviceName" defaultValue="First browser" maxLength={80} /></label>
          <label>SSH target<input name="sshTarget" placeholder="user@server" defaultValue={server?.sshTarget || ""} spellCheck={false} /><small>Leave empty only when this container runs directly on the server.</small></label>
          <label>SSH port<input name="sshPort" type="number" min={1} max={65535} defaultValue={server?.sshPort || 22} required /></label>
          <label>Script root<input name="scriptRoot" defaultValue={server?.scriptRoot || "/home"} required spellCheck={false} /></label>
          <label>Allowed paths<input name="allowedPaths" defaultValue={server?.allowedPaths.join(", ") || "/home"} required spellCheck={false} /><small>Comma-separated absolute paths the dashboard may browse or run scripts from.</small></label>
          <label>Remote logs folder<input name="remoteLogs" defaultValue={server?.remoteLogs || "/tmp/media-dashboard"} required spellCheck={false} /></label>
          <small>Find the token with <code>docker compose logs dashboard</code>. The SSH key and server fingerprint must already be mounted as <code>/run/ssh/id_ed25519</code> and <code>/run/ssh/known_hosts</code>. This browser will be authorized automatically.</small>
          <Btn className="primary full" disabled={loading}>{loading ? "Setting up…" : "Finish setup"}</Btn>
        </form>
      </section>
    </main>
  );
}
