"use client";
// How to make a device trust the dashboard's HTTPS certificate, for the system
// it runs on. A browser offers to save the password only on an address whose
// certificate it trusts; trusted once, the HTTPS address also opens without a
// warning, and phones can install the dashboard as an app.
import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { api } from "@/lib/client-api";
import { locale, msg, t } from "@/lib/i18n";
import { rich } from "@/components/ui";

type Info = { available: boolean; address: string | null; fingerprint?: string; validTo?: string };
type System = "windows" | "macos" | "ios" | "android" | "linux" | "chromeos";
const SYSTEMS: [System, string][] = [
  ["windows", "Windows"], ["macos", "macOS"], ["ios", "iPhone / iPad"],
  ["android", "Android"], ["linux", "Linux"], ["chromeos", "ChromeOS"],
];
const STEPS: Record<System, string[]> = {
  windows: [
    msg("Open the downloaded file and choose Install Certificate, then Current User."),
    msg("Choose “Place all certificates in the following store”, then Browse, and select Trusted Root Certification Authorities."),
    msg("Finish, answer Yes to the security warning, and restart the browser."),
  ],
  macos: [
    msg("Open the downloaded file: Keychain Access adds the certificate."),
    msg("Open the certificate in Keychain Access, expand Trust and set “When using this certificate” to Always Trust."),
    msg("Close the window, confirm with your Mac's password, and restart the browser."),
  ],
  ios: [
    msg("Download the certificate in Safari and allow the configuration profile."),
    msg("In Settings, open Profile Downloaded (or General → VPN & Device Management) and install it."),
    msg("In Settings → General → About → Certificate Trust Settings, turn on full trust for it."),
  ],
  android: [
    msg("In Settings, search for “CA certificate”: Security → Encryption & credentials → Install a certificate → CA certificate."),
    msg("Choose Install anyway, pick the downloaded file, and restart Chrome."),
  ],
  linux: [
    msg("In Chrome, open Settings → Privacy and security → Security → Manage certificates, and import the file as a trusted authority."),
  ],
  chromeos: [
    msg("Open Settings → Privacy and security → Security → Manage certificates → Authorities, import the file, and tick “Trust this certificate for identifying websites”."),
  ],
};
const DESKTOP = new Set<System>(["windows", "macos", "linux"]);
function detectSystem(): System {
  const agent = navigator.userAgent;
  // iPads describe themselves as Macs, but have a touch screen.
  if (/iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1)) return "ios";
  if (/Android/.test(agent)) return "android";
  if (/CrOS/.test(agent)) return "chromeos";
  if (/Macintosh|Mac OS X/.test(agent)) return "macos";
  if (/Linux/.test(agent)) return "linux";
  return "windows";
}
function useCertificate() {
  const [info, setInfo] = useState<Info | null>(null);
  useEffect(() => {
    void api("certificate", undefined, true).then(setInfo).catch(() => setInfo({ available: false, address: null }));
  }, []);
  return info;
}
// On the sign-in page, and only once there is a certificate to download.
export function CertificateSignIn() {
  const info = useCertificate();
  if (!info?.available) return null;
  return (
    <details className="enroll certificate-sign-in">
      <summary>{t("Save the password in this browser")}</summary>
      <CertificateSteps info={info} />
    </details>
  );
}
// In Settings, which also says how to turn HTTPS on.
export function CertificateHelp() {
  const info = useCertificate();
  if (!info) return <p className="certificate-help">{t("Loading…")}</p>;
  return <CertificateSteps info={info} />;
}
function CertificateSteps({ info }: { info: Info }) {
  const [system, setSystem] = useState<System>(() => (typeof navigator === "undefined" ? "windows" : detectSystem()));
  if (!info.available)
    return (
      <div className="certificate-help">
        <p>{rich(t("HTTPS is not enabled. On the server, set COOKIE_SECURE=true in .env and run {command} in the dashboard's folder; the certificate can then be downloaded here."), { command: <code>docker compose --profile https up -d</code> })}</p>
      </div>
    );
  // iPhones install a profile that Safari opens itself, so it is not saved as a file.
  const file = system === "linux" ? "/api/certificate/file?format=pem" : system === "ios" ? "/api/certificate/file?inline=1" : "/api/certificate/file";
  const elsewhere = info.address && typeof window !== "undefined" && window.location.origin !== info.address;
  return (
    <div className="certificate-help">
      <label>
        {t("Device")}
        <select value={system} onChange={(event) => setSystem(event.target.value as System)}>
          {SYSTEMS.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </label>
      <a className="button primary" href={file} {...(system === "ios" ? {} : { download: "" })}>
        <Download size={16} />
        {t("Download certificate")}
      </a>
      <ol>
        {STEPS[system].map((step) => <li key={step}>{t(step)}</li>)}
        {system === "linux" && <li>{rich(t("For the whole system as well, run {command}"), { command: <code>sudo cp linux-server-control-ca.pem /usr/local/share/ca-certificates/linux-server-control-ca.crt && sudo update-ca-certificates</code> })}</li>}
        {elsewhere && <li>{rich(t("Then open the secure address {address} and sign in: the browser offers to save the password."), { address: <a href={info.address!}>{info.address}</a> })}</li>}
      </ol>
      {DESKTOP.has(system) && <p className="certificate-note">{t("Firefox keeps its own list: Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import, then tick “Trust this CA to identify websites”.")}</p>}
      <details className="certificate-check">
        <summary>{t("Check the certificate")}</summary>
        <p>{t("Before trusting it, compare this SHA-256 fingerprint with the one your device shows.")}</p>
        <code>{info.fingerprint}</code>
        {info.validTo && <small>{t("Valid until {date}", { date: new Date(info.validTo).toLocaleDateString(locale(), { dateStyle: "long" }) })}</small>}
      </details>
    </div>
  );
}
