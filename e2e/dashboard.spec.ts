import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { type Browser, type Page, expect, test } from "@playwright/test";
import { ADMIN_STATE, CRONTAB, FILES, PASSWORD, PLUG, USERNAME, WEBHOOK, WEBHOOKS } from "./paths";

const PAGES = ["Overview", "Containers", "Scripts", "Files", "Schedules", "Power", "History", "Alerts", "Settings"];
const heading = (page: Page, name: string) => page.getByRole("heading", { name, level: 1 });
async function open(page: Page, name: string) {
  await page.getByRole("navigation").getByRole("button", { name, exact: true }).click();
  await expect(heading(page, name)).toBeVisible();
}
const modal = (page: Page) => page.locator(".modal");
// A browser that is enrolled (it has the device cookie) but not signed in.
async function enrolledBrowser(browser: Browser) {
  const state = JSON.parse(readFileSync(ADMIN_STATE, "utf8"));
  return browser.newContext({ storageState: { cookies: state.cookies.filter((cookie: { name: string }) => cookie.name === "lsc_device"), origins: [] } });
}
async function signIn(page: Page, username: string, password: string) {
  await page.goto("/");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("every page opens without a script error", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(heading(page, "Overview")).toBeVisible();
  await expect(page.getByText("CPU usage")).toBeVisible();
  for (const name of PAGES) await open(page, name);
  expect(errors).toEqual([]);
});

test("settings check what the server provides", async ({ page }) => {
  await page.goto("/");
  await open(page, "Settings");
  await page.getByRole("button", { name: "Check server requirements" }).click();
  const checks = page.locator(".preflight");
  await expect(checks.getByText("SSH connection")).toBeVisible();
  await expect(checks.getByText("python3")).toBeVisible();
});

test("files can be created, edited and deleted inside the allowed folder", async ({ page }) => {
  await page.goto("/");
  await open(page, "Files");
  await expect(page.getByText("notes.txt")).toBeVisible();

  await page.getByRole("button", { name: "New folder" }).click();
  await modal(page).getByRole("textbox").fill("reports");
  await modal(page).getByRole("button", { name: "Create folder" }).click();
  await page.locator(".file-explorer-open", { hasText: "reports" }).click();
  await expect(page.getByText("This folder is empty")).toBeVisible();

  await page.getByRole("button", { name: "New file" }).click();
  await modal(page).getByRole("textbox").fill("today.txt");
  await modal(page).getByRole("button", { name: "Create file" }).click();
  await page.locator(".file-explorer-open", { hasText: "today.txt" }).click();
  await modal(page).locator("textarea").fill("written in the browser\n");
  await modal(page).getByRole("button", { name: "Save changes" }).click();
  await expect(modal(page)).toBeHidden();
  const file = path.join(FILES, "reports", "today.txt");
  expect(readFileSync(file, "utf8")).toBe("written in the browser\n");

  await page.getByRole("button", { name: "Actions for today.txt" }).click();
  await page.locator(".file-explorer-menu-items").getByRole("button", { name: "Delete" }).click();
  await modal(page).getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("This folder is empty")).toBeVisible();
  expect(existsSync(file)).toBe(false);

  // Paths outside the allowed folder are refused.
  await page.getByLabel("Folder path").fill("/etc");
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await expect(page.getByText("outside the allowed locations")).toBeVisible();
});

test("a script is created, run and recorded in the history", async ({ page }) => {
  await page.goto("/");
  await open(page, "Scripts");
  await page.getByRole("button", { name: "New custom script" }).click();
  await modal(page).locator('input[name="name"]').fill("Greeting");
  await modal(page).locator('input[name="filename"]').fill("greeting.sh");
  await modal(page).locator('input[name="directory"]').fill(FILES);
  await modal(page).locator('textarea[name="content"]').fill("#!/usr/bin/env bash\necho hello from the browser test\n");
  await modal(page).getByRole("button", { name: "Create script" }).click();
  await expect(modal(page)).toBeHidden();
  expect(existsSync(path.join(FILES, "greeting.sh"))).toBe(true);

  await page.locator(".script-folder summary", { hasText: "Unfiled" }).click();
  const row = page.locator(".script-row", { hasText: "Greeting" });
  await row.getByRole("button", { name: "Run" }).click();
  await expect(modal(page).locator("pre")).toContainText("hello from the browser test", { timeout: 15000 });
  await modal(page).getByRole("button", { name: "Close" }).click();

  await open(page, "History");
  const run = page.locator(".schedule-row", { hasText: "Greeting" }).first();
  await expect(run.locator(".badge")).toHaveText("success", { timeout: 15000 });
});

test("a schedule is written to the crontab, runs, and can be paused and deleted", async ({ page }) => {
  await page.goto("/");
  const created = await page.request.post("/api/script/create-custom", { data: { name: "Nightly job", filename: "nightly.sh", directory: FILES, content: "echo nightly output\n" } });
  expect(created.status()).toBe(200);
  await open(page, "Schedules");
  await page.getByRole("button", { name: "New schedule" }).click();
  await modal(page).locator('select[name="scriptId"]').selectOption({ label: "Nightly job" });
  await modal(page).getByRole("button", { name: "Create schedule" }).click();
  await expect(modal(page)).toBeHidden();
  const row = page.locator(".schedule-row", { hasText: "Nightly job" });
  await expect(row.getByText("Every day at 03:00 · 0 3 * * *")).toBeVisible();
  await expect(row.locator(".badge")).toHaveText("Enabled");

  const managed = () => readFileSync(CRONTAB, "utf8").split("\n").filter((line) => line.includes("# media-dashboard:"));
  expect(readFileSync(CRONTAB, "utf8")).toContain("# my own job\n0 1 * * * true\n");
  expect(managed()).toHaveLength(1);
  expect(managed()[0]).toContain(`/bin/bash '${path.join(FILES, "nightly.sh")}'`);

  // Run the job the way cron would, then find it in the history.
  execFileSync("sh", ["-c", managed()[0].slice("0 3 * * * ".length).replaceAll("\\%", "%")]);
  await open(page, "History");
  await page.getByRole("button", { name: /Cron runs/ }).click();
  const run = page.locator(".schedule-row", { hasText: "Every day at 03:00" }).first();
  await expect(run.locator(".badge")).toHaveText("success", { timeout: 15000 });

  await open(page, "Schedules");
  await row.getByRole("button", { name: "Pause" }).click();
  await expect(row.locator(".badge")).toHaveText("Paused");
  expect(managed()).toHaveLength(0);
  await row.getByRole("button", { name: "Enable" }).click();
  await expect(row.locator(".badge")).toHaveText("Enabled");
  expect(managed()).toHaveLength(1);
  await row.getByRole("button", { name: "Delete" }).click();
  await expect(row).toHaveCount(0);
  expect(readFileSync(CRONTAB, "utf8")).toBe("# my own job\n0 1 * * * true\n");
});

test("a power device is added, read and switched", async ({ page }) => {
  await page.goto("/");
  await open(page, "Power");
  await page.getByRole("button", { name: "Add device" }).click();
  await modal(page).locator('select[name="driver"]').selectOption("shelly");
  await modal(page).locator('input[name="name"]').fill("Test plug");
  await modal(page).locator('input[name="host"]').fill(PLUG);
  await modal(page).getByRole("button", { name: "Add device" }).click();
  await expect(modal(page)).toBeHidden();
  const row = page.locator(".schedule-row", { hasText: "Test plug" });
  await expect(row.locator(".badge")).toHaveText("9.0 W");
  await expect(page.locator(".metric", { hasText: "Power now" })).toContainText("9.0 W");

  await row.getByRole("button", { name: "Turn off" }).click();
  await expect(modal(page).getByText("Everything powered through it loses power")).toBeVisible();
  await modal(page).getByRole("button", { name: "Turn off" }).click();
  await expect(row.locator(".badge")).toHaveText("0.0 W · off");
  await row.getByRole("button", { name: "Turn on" }).click();
  await expect(row.locator(".badge")).toHaveText("9.0 W");
});

test("a notification channel is added and receives a test message", async ({ page }) => {
  await page.goto("/");
  await open(page, "Settings");
  await page.getByRole("button", { name: "Add channel" }).click();
  await modal(page).getByLabel("Service").selectOption("webhook");
  await modal(page).locator('input[name="name"]').fill("Test hook");
  await modal(page).locator('input[name="url"]').fill(WEBHOOK);
  await modal(page).getByRole("button", { name: "Add channel" }).click();
  await expect(modal(page)).toBeHidden();
  const row = page.locator(".schedule-row", { hasText: "Test hook" });
  // The address is shown without its path, which may hold the credentials.
  await expect(row).toContainText("127.0.0.1:3212");
  await expect(row).not.toContainText("/hook");
  await row.getByRole("button", { name: "Test" }).click();
  await expect(row.getByText("Test sent.")).toBeVisible();
  const received = readFileSync(WEBHOOKS, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(received.at(-1)).toMatchObject({ source: "linux-server-control", title: "Test notification", severity: "info" });
});

test("a read-only account sees the pages but cannot change anything", async ({ page, browser }) => {
  await page.goto("/");
  await open(page, "Settings");
  await page.getByRole("button", { name: "Add account" }).click();
  await modal(page).locator('input[name="username"]').fill("guest");
  await modal(page).locator('input[name="password"]').fill("guest-test-password");
  await modal(page).getByRole("button", { name: "Add account" }).click();
  const account = page.locator(".device-row", { hasText: "guest" });
  await expect(account.getByText("Read-only")).toBeVisible();

  const context = await enrolledBrowser(browser);
  const guest = await context.newPage();
  await signIn(guest, "guest", "guest-test-password");
  await expect(heading(guest, "Overview")).toBeVisible();
  await expect(guest.getByText("guest (read-only)")).toBeVisible();
  await expect(guest.getByRole("navigation").getByRole("button", { name: "Files" })).toHaveCount(0);
  await open(guest, "Scripts");
  await expect(guest.getByRole("button", { name: "New custom script" })).toHaveCount(0);
  await open(guest, "Settings");
  await expect(guest.getByRole("heading", { name: "Change password" })).toBeVisible();
  await expect(guest.getByRole("heading", { name: "Accounts" })).toHaveCount(0);
  // The interface hides the controls; the API refuses the requests as well.
  for (const [route, data] of [["script/run", { id: "any" }], ["file/browse", { path: FILES }], ["container", { name: "any", action: "stop" }], ["users/save", { username: "x", role: "admin", password: "another-long-password" }], ["power/device/switch", { id: "any", on: false }]] as const)
    expect((await guest.request.post(`/api/${route}`, { data })).status(), route).toBe(403);
  expect((await guest.request.get("/api/config/export")).status()).toBe(403);
  expect((await guest.request.get("/api/state?scope=records")).status()).toBe(200);
  await context.close();
});

test("sign-in rejects a wrong password and a browser that is not enrolled", async ({ page, browser }) => {
  const enrolled = await enrolledBrowser(browser);
  const known = await enrolled.newPage();
  await signIn(known, USERNAME, "not-the-password");
  await expect(known.getByText("Incorrect username or password")).toBeVisible();
  await enrolled.close();

  const fresh = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const unknown = await fresh.newPage();
  await signIn(unknown, USERNAME, PASSWORD);
  await expect(unknown.getByText("New browser: enter an enrollment code")).toBeVisible();

  // An access code from an authorized browser enrolls the new one.
  await page.goto("/");
  await open(page, "Settings");
  await page.getByRole("button", { name: "Generate access code" }).click();
  const code = await modal(page).locator("code").innerText();
  await unknown.getByText("New browser? Enter an enrollment code").click();
  await unknown.getByLabel("Code").fill(code);
  await unknown.getByLabel("Device name").fill("Second browser");
  await unknown.getByRole("button", { name: "Sign in" }).click();
  await expect(heading(unknown, "Overview")).toBeVisible();
  await fresh.close();
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("no page scrolls sideways", async ({ page }) => {
    await page.goto("/");
    await expect(heading(page, "Overview")).toBeVisible();
    for (const name of PAGES) {
      await open(page, name);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${name} is wider than the screen`).toBeLessThanOrEqual(1);
    }
  });
});
