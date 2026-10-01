import path from "node:path";

// Shared with e2e/server.mjs, which creates these folders.
export const PORT = 3210;
export const TMP = path.join(__dirname, ".tmp");
export const DATA = path.join(TMP, "data");
export const FILES = path.join(TMP, "files");
export const ADMIN_STATE = path.join(TMP, "admin.json");
export const USERNAME = "admin";
export const PASSWORD = "browser-test-password";
