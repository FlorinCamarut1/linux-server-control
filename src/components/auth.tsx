"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client-api";
import { CertificateSignIn } from "@/components/certificate";
import { ServerSettingsForm } from "@/components/settings";
import { Btn, PreflightList, rich } from "@/components/ui";
import { LanguageSelect } from "@/components/language";
import { t } from "@/lib/i18n";
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
        <p>{t("Secure administration for your Linux server.")}</p>
        <LanguageSelect compact />
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
              setMsg(x instanceof Error ? x.message : t("Error"));
            }
          }}
        >
          <label>
            {t("Username")}
            <input name="username" autoComplete="username" />
          </label>
          <label>
            {t("Password")}
            <input name="password" type="password" autoComplete="current-password" />
          </label>
          <details className="enroll">
            <summary>{t("New browser? Enter an enrollment code")}</summary>
            <label>
              {t("Code")}
              <input name="code" autoComplete="off" spellCheck={false} />
            </label>
            <label>
              {t("Device name")}
              <input name="deviceName" />
            </label>
          </details>
          <Btn className="primary full" disabled={loading}>
            {loading && <Loader2 className="spin" size={16} />}
            {loading ? t("Signing in…") : t("Sign in")}
          </Btn>
        </form>
        {/* Before the first sign-in on a device, so that it can save the password. */}
        <CertificateSignIn />
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
        <h1>{t("Server unavailable")}</h1>
        <p>{t("Your dashboard session is still valid, but it cannot reach the managed server over SSH.")}</p>
        <div className="alert">{error}</div>
        <p>{t("Check that the server is online, then verify the SSH target, key, and known_hosts mount.")}</p>
        <Btn className="primary full" disabled={loading} onClick={retry}>{loading ? t("Reconnecting…") : t("Reconnect")}</Btn>
        {admin && (
          <details className="enroll reconnect-settings">
            <summary>{t("Change the connection settings")}</summary>
            <ServerSettingsForm saved={retry} />
          </details>
        )}
        <Btn className="full reconnect-sign-out" onClick={signOut}>{t("Sign out")}</Btn>
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
          <h1>{t("Setup complete")}</h1>
          <p>{t("The account was created and the server answered. Some features need the items below; you can install them later and check again under Settings → Server connection.")}</p>
          <PreflightList checks={checks.filter((check) => check.status === "error" || check.status === "warning")} />
          <Btn className="primary full" onClick={done}>{t("Continue to the dashboard")}</Btn>
        </section>
      </main>
    );
  return (
    <main className="login-wrap">
      <section className="login-card">
        <div className="login-logo"><img src="/icon.svg" alt="" /></div>
        <h1>{t("Set up Linux Server Control")}</h1>
        <p>{t("Create the administrator account and verify the server connection.")}</p>
        <LanguageSelect compact />
        {message && <div className="alert">{message}</div>}
        <form key={server ? "loaded" : "loading"} onSubmit={async (event) => {
          event.preventDefault();
          try {
            const result = await api("setup", Object.fromEntries(new FormData(event.currentTarget)));
            const found: PreflightCheck[] = result.checks || [];
            if (found.some((check) => check.status === "error" || check.status === "warning")) setChecks(found);
            else done();
          } catch (reason) {
            setMessage(reason instanceof Error ? reason.message : t("Setup failed"));
          }
        }}>
          <label>{t("Setup token")}<input name="setupToken" required autoComplete="one-time-code" spellCheck={false} /></label>
          <label>{t("Username")}<input name="username" defaultValue="admin" required maxLength={40} autoComplete="username" /></label>
          <label>{t("Password")}<input name="password" type="password" minLength={12} required autoComplete="new-password" /></label>
          <label>{t("Confirm password")}<input name="confirmPassword" type="password" minLength={12} required autoComplete="new-password" /></label>
          <label>{t("Device name")}<input name="deviceName" defaultValue={t("First browser")} maxLength={80} /></label>
          <label>{t("SSH target")}<input name="sshTarget" placeholder="user@server" defaultValue={server?.sshTarget || ""} spellCheck={false} /><small>{t("Leave empty only when this container runs directly on the server.")}</small></label>
          <label>{t("SSH port")}<input name="sshPort" type="number" min={1} max={65535} defaultValue={server?.sshPort || 22} required /></label>
          <label>{t("Script root")}<input name="scriptRoot" defaultValue={server?.scriptRoot || "/home"} required spellCheck={false} /></label>
          <label>{t("Allowed paths")}<input name="allowedPaths" defaultValue={server?.allowedPaths.join(", ") || "/home"} required spellCheck={false} /><small>{t("Comma-separated absolute paths the dashboard may browse or run scripts from.")}</small></label>
          <label>{t("Remote logs folder")}<input name="remoteLogs" defaultValue={server?.remoteLogs || "/tmp/media-dashboard"} required spellCheck={false} /></label>
          <small>{rich(t("Find the token with {command}. The SSH key and server fingerprint must already be mounted as {key} and {hosts}. This browser will be authorized automatically."), { command: <code>docker compose logs dashboard</code>, key: <code>/run/ssh/id_ed25519</code>, hosts: <code>/run/ssh/known_hosts</code> })}</small>
          <Btn className="primary full" disabled={loading}>{loading ? t("Setting up…") : t("Finish setup")}</Btn>
        </form>
      </section>
    </main>
  );
}
