import { defineConfig, devices } from "@playwright/test";
import { ADMIN_STATE, PORT } from "./e2e/paths";

// Browser tests against the production build (run `npm run build` first).
// e2e/server.mjs starts it on this machine, without SSH, on a throwaway data
// folder; the setup project creates the account the other tests sign in with.
export default defineConfig({
  testDir: "e2e",
  // The tests share one dashboard, so they run one after another.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "setup", testMatch: "setup.spec.ts", use: { ...devices["Desktop Chrome"] } },
    { name: "dashboard", testIgnore: "setup.spec.ts", dependencies: ["setup"], use: { ...devices["Desktop Chrome"], storageState: ADMIN_STATE } },
  ],
  webServer: {
    command: "node e2e/server.mjs",
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60000,
  },
});
