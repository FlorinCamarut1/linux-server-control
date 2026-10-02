import path from "node:path";

// Shared with e2e/server.mjs, which creates these folders.
export const PORT = 3210;
export const TMP = path.join(__dirname, ".tmp");
export const DATA = path.join(TMP, "data");
export const FILES = path.join(TMP, "files");
// Stand-ins started by e2e/server.mjs: the crontab the fake `crontab` command
// keeps, a Shelly plug, and a webhook receiver that records what it is sent.
export const CRONTAB = path.join(TMP, "crontab");
export const PLUG = "127.0.0.1:3211";
export const WEBHOOK = "http://127.0.0.1:3212/hook";
export const WEBHOOKS = path.join(TMP, "webhooks.jsonl");
export const ADMIN_STATE = path.join(TMP, "admin.json");
export const USERNAME = "admin";
export const PASSWORD = "browser-test-password";
