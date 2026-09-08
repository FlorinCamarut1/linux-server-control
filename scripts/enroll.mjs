import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
const dir = process.env.DATA_DIR || "/app/data",
  code = randomBytes(12).toString("base64url");
mkdirSync(dir, { recursive: true });
writeFileSync(
  `${dir}/enroll.json`,
  JSON.stringify({ code, expires: Date.now() / 1000 + 900 }, null, 2),
  { mode: 0o600 },
);
console.log(`Code valid for 15 minutes: ${code}`);
