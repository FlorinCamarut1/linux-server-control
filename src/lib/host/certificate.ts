// The certificate a browser has to trust before it accepts the HTTPS address
// without a warning, and only then offers to save the password. With the
// Compose file's HTTPS service it is the root of Caddy's own authority, which
// Caddy serves inside the Compose network; HTTPS_CA_CERT names a file instead,
// for a certificate made some other way. Only the public certificate is read.
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

const CADDY_ROOT = process.env.HTTPS_CA_URL || "http://https:8080/root.crt";
// Looked up at most once a minute: without the HTTPS service the address does
// not resolve, and the sign-in page asks on every visit.
const KEEP_MS = 60 * 1000;
let kept: { at: number; certificate: X509Certificate | null } | null = null;

async function load() {
  const pem = process.env.HTTPS_CA_CERT
    ? readFileSync(process.env.HTTPS_CA_CERT, "utf8")
    : await fetch(CADDY_ROOT, { signal: AbortSignal.timeout(2000), cache: "no-store" }).then((response) => (response.ok ? response.text() : ""));
  return pem.includes("BEGIN CERTIFICATE") ? new X509Certificate(pem) : null;
}
export async function httpsCertificate() {
  if (kept && Date.now() - kept.at < KEEP_MS) return kept.certificate;
  let certificate: X509Certificate | null = null;
  try { certificate = await load(); } catch {}
  kept = { at: Date.now(), certificate };
  return certificate;
}
// The HTTPS addresses of the Compose file's HTTPS service: HTTPS_HOST may list
// several names and addresses, separated by commas.
export function httpsAddresses() {
  const hosts = (process.env.HTTPS_HOST || process.env.LAN_IP || "").split(",").map((host) => host.trim());
  return hosts.filter((host) => host && host !== "0.0.0.0").map((host) => `https://${host}:8444`);
}
