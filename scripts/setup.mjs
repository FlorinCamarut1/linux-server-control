import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, scryptSync } from "node:crypto";
const dir = process.env.DATA_DIR || "/app/data",
  password = process.env.DASHBOARD_PASSWORD;
if (!password || password.length < 12)
  throw Error("Set DASHBOARD_PASSWORD to at least 12 characters.");
mkdirSync(dir, { recursive: true });
// Run on an existing installation, this resets the owner's password; the
// username stays unless DASHBOARD_USER names another.
let existing = {};
try {
  existing = JSON.parse(readFileSync(`${dir}/config.json`, "utf8"));
} catch {}
const username = process.env.DASHBOARD_USER || existing.username || "admin";
const salt = randomBytes(16).toString("hex");
const hash = scryptSync(password, Buffer.from(salt, "hex"), 64, {
  N: 16384,
  r: 8,
  p: 1,
}).toString("hex");
writeFileSync(
  `${dir}/config.json`,
  JSON.stringify({ username, salt, password: hash }, null, 2),
  { mode: 0o600 },
);
console.log(`Configuration saved for the account ${username}.`);
