import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes, scryptSync } from "node:crypto";
const dir = process.env.DATA_DIR || "/app/data",
  password = process.env.DASHBOARD_PASSWORD;
if (!password || password.length < 12)
  throw Error("Set DASHBOARD_PASSWORD to at least 12 characters.");
mkdirSync(dir, { recursive: true });
const salt = randomBytes(16).toString("hex");
const hash = scryptSync(password, Buffer.from(salt, "hex"), 64, {
  N: 16384,
  r: 8,
  p: 1,
}).toString("hex");
writeFileSync(
  `${dir}/config.json`,
  JSON.stringify(
    { username: process.env.DASHBOARD_USER || "admin", salt, password: hash },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log("Configuration saved.");
