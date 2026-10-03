import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Browser, type Locator, type Page, expect, test } from "@playwright/test";
import { ADMIN_STATE, CRONTAB, DATA, FILES, PASSWORD, PLUG, USERNAME, WEBHOOK, WEBHOOKS } from "./paths";

const PAGES = ["Overview", "Containers", "Scripts", "Files", "Schedules", "Power", "History", "Alerts", "Settings"];
const heading = (page: Page, name: string) => page.getByRole("heading", { name, level: 1 });
// On a phone the pages are in the menu of the top bar.
async function open(page: Page, name: string) {
  const menu = page.getByRole("button", { name: "Open the menu" });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("navigation").getByRole("button", { name, exact: true }).click();
  await expect(heading(page, name)).toBeVisible();
}
// The topmost dialog: a confirmation opens above the dialog that asked for it.
const modal = (page: Page) => page.locator(".modal").last();
// Opens the "⋯" menu of a row and chooses one of its items.
async function choose(page: Page, row: Locator, item: string) {
  await row.getByRole("button", { name: /^Actions for/ }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: item, exact: true }).click();
}
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

  await choose(page, page.locator(".file-explorer-card", { hasText: "today.txt" }), "Delete");
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

test("a running script is stopped from its log and recorded as stopped", async ({ page }) => {
  await page.goto("/");
  const created = await page.request.post("/api/script/create-custom", { data: { name: "Long job", filename: "long.sh", directory: FILES, content: "echo working\nsleep 600\n" } });
  expect(created.status()).toBe(200);
  await open(page, "Scripts");
  await page.locator(".script-folder summary", { hasText: "Unfiled" }).click();
  const row = page.locator(".script-row", { hasText: "Long job" });
  await row.getByRole("button", { name: "Run" }).click();
  const viewer = page.getByRole("dialog", { name: "Long job logs" });
  await expect(viewer.locator("pre")).toContainText("working", { timeout: 15000 });
  await expect(viewer).toContainText("Running since");
  await expect(row.locator(".badge", { hasText: "Running" })).toBeVisible();

  // Stopping asks first; the confirmation opens above the log.
  await viewer.getByRole("button", { name: "Stop run" }).click();
  await expect(modal(page).getByText("Stop this run of Long job?")).toBeVisible();
  await modal(page).getByRole("button", { name: "Stop run" }).click();
  await expect(viewer).toContainText("Stopped by admin", { timeout: 15000 });
  await expect(viewer.locator("pre")).toContainText("[Stopped by admin.]");
  await expect(viewer.getByRole("button", { name: "Stop run" })).toHaveCount(0);
  await viewer.getByRole("button", { name: "Close" }).click();

  await open(page, "History");
  const run = page.locator(".schedule-row", { hasText: "Long job" }).first();
  await expect(run.locator(".badge")).toHaveText("stopped");
  await expect(run).toContainText("stopped by admin");
  // A stopped run needs no attention.
  await open(page, "Overview");
  await expect(page.locator(".panel", { hasText: "Attention needed" })).not.toContainText("Long job");
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
  await choose(page, row, "Pause");
  await expect(row.locator(".badge")).toHaveText("Paused");
  expect(managed()).toHaveLength(0);
  await choose(page, row, "Enable");
  await expect(row.locator(".badge")).toHaveText("Enabled");
  expect(managed()).toHaveLength(1);
  // Deleting asks first; declining keeps the schedule and its crontab line.
  await choose(page, row, "Delete");
  await modal(page).getByRole("button", { name: "Cancel" }).click();
  await expect(row).toHaveCount(1);
  expect(managed()).toHaveLength(1);
  await choose(page, row, "Delete");
  await modal(page).getByRole("button", { name: "Delete", exact: true }).click();
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

  await choose(page, row, "Turn off");
  await expect(modal(page).getByText("Everything powered through it loses power")).toBeVisible();
  await modal(page).getByRole("button", { name: "Turn off" }).click();
  await expect(row.locator(".badge")).toHaveText("0.0 W · off");
  await choose(page, row, "Turn on");
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
  await choose(page, row, "Send test");
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
  await guest.locator(".script-folder summary", { hasText: "Unfiled" }).click();
  await expect(guest.locator(".script-row").first().getByRole("button", { name: "Logs" })).toBeVisible();
  await expect(guest.getByRole("button", { name: /^Actions for/ })).toHaveCount(0);
  await open(guest, "Settings");
  await expect(guest.getByRole("heading", { name: "Change password" })).toBeVisible();
  await expect(guest.getByRole("heading", { name: "Accounts" })).toHaveCount(0);
  // The interface hides the controls; the API refuses the requests as well.
  for (const [route, data] of [["script/run", { id: "any" }], ["script/stop", { runId: "any" }], ["file/browse", { path: FILES }], ["container", { name: "any", action: "stop" }], ["users/save", { username: "x", role: "admin", password: "another-long-password" }], ["power/device/switch", { id: "any", on: false }]] as const)
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

test("rows keep their actions in a menu, and deleting always asks first", async ({ page }) => {
  await page.goto("/");
  await open(page, "Alerts");
  await page.getByRole("button", { name: "New alert" }).click();
  await modal(page).locator('input[name="name"]').fill("Disks filling up");
  await modal(page).locator('select[name="metric"]').selectOption("storage");
  await modal(page).locator('input[name="threshold"]').fill("95");
  await modal(page).getByRole("button", { name: "Save alert" }).click();
  const rule = page.locator(".schedule-row", { hasText: "Disks filling up" });
  await expect(rule).toContainText("Use of the fullest monitored storage path ≥ 95%");

  // No row shows a delete button of its own, on any page.
  for (const name of ["Scripts", "Schedules", "Power", "Alerts", "Settings"]) {
    await open(page, name);
    if (name === "Scripts") await page.locator(".script-folder summary", { hasText: "Unfiled" }).click();
    await expect(page.locator("main .button.danger")).toHaveCount(0);
  }

  // The menu works from the keyboard: it takes the focus, and Escape gives it back.
  await open(page, "Alerts");
  const trigger = rule.getByRole("button", { name: "Actions for the alert Disks filling up" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Edit" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Delete" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  // A press elsewhere closes it too.
  await trigger.click();
  await expect(menu).toBeVisible();
  await page.getByRole("heading", { name: "Alert rules" }).click();
  await expect(menu).toHaveCount(0);

  await choose(page, rule, "Edit");
  await expect(modal(page).locator('input[name="name"]')).toHaveValue("Disks filling up");
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal")).toHaveCount(0);

  await choose(page, rule, "Delete");
  await expect(modal(page).getByText("Delete the alert rule “Disks filling up”?")).toBeVisible();
  await modal(page).getByRole("button", { name: "Cancel" }).click();
  await expect(rule).toHaveCount(1);
  await choose(page, rule, "Delete");
  await modal(page).getByRole("button", { name: "Delete", exact: true }).click();
  await expect(rule).toHaveCount(0);

  // Inside a dialog the menu opens above it, and Escape closes the menu alone.
  await open(page, "Settings");
  await page.getByRole("button", { name: "Manage storage paths" }).click();
  await modal(page).locator('input[name="path"]').fill(FILES);
  await modal(page).getByRole("button", { name: "Add storage path" }).click();
  const stored = modal(page).locator(".schedule-row", { hasText: FILES });
  await stored.getByRole("button", { name: /^Actions for/ }).click();
  await expect(page.getByRole("menu").getByRole("menuitem", { name: "Remove" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Monitored storage" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal")).toHaveCount(0);

  // The browser in use is marked among the authorized ones.
  const browsers = page.locator(".panel", { hasText: "Authorized browsers" }).locator(".device-row");
  const own = browsers.filter({ hasText: "This browser" });
  await expect(own).toHaveCount(1);
  await expect(own).toContainText("First browser");
});

test("Overview lists a failing script until it runs successfully again", async ({ page }) => {
  await page.goto("/");
  const created = await page.request.post("/api/script/create-custom", { data: { name: "Flaky job", filename: "flaky.sh", directory: FILES, content: "echo about to fail\nexit 3\n" } });
  expect(created.status()).toBe(200);
  await open(page, "Scripts");
  await page.locator(".script-folder summary", { hasText: "Unfiled" }).click();
  const row = page.locator(".script-row", { hasText: "Flaky job" });
  await row.getByRole("button", { name: "Run" }).click();
  await expect(modal(page).locator("pre")).toContainText("about to fail", { timeout: 15000 });
  await modal(page).getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(row).toContainText("last run failed", { timeout: 20000 });

  await open(page, "Overview");
  const attention = page.locator(".panel", { hasText: "Attention needed" });
  const failure = attention.locator(".schedule-row", { hasText: "Failed script: Flaky job" });
  await expect(failure).toContainText("exit code 3");
  await failure.getByRole("button", { name: "View log" }).click();
  await expect(modal(page).locator("pre")).toContainText("about to fail");
  await modal(page).getByRole("button", { name: "Close" }).click();

  // Fixed and run again, it no longer needs attention, though History keeps the failure.
  writeFileSync(path.join(FILES, "flaky.sh"), "#!/usr/bin/env bash\necho fixed\n");
  await open(page, "Scripts");
  await row.getByRole("button", { name: "Run" }).click();
  await expect(modal(page).locator("pre")).toContainText("fixed", { timeout: 15000 });
  await modal(page).getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(row).toContainText("last run success", { timeout: 20000 });
  await open(page, "Overview");
  await expect(failure).toHaveCount(0);
  await open(page, "History");
  await page.getByLabel("Filter status").selectOption("failed");
  await expect(page.locator(".schedule-row", { hasText: "Flaky job" })).toHaveCount(1);
});

test("the editor asks before discarding changes that were not saved", async ({ page }) => {
  await page.goto("/");
  await open(page, "Files");
  await page.locator(".file-explorer-open", { hasText: "notes.txt" }).click();
  const editor = page.getByRole("dialog", { name: "Edit file" });
  await editor.locator("textarea").fill("changed but not saved\n");
  await page.keyboard.press("Escape");
  await expect(modal(page).getByText("discard the changes you have not saved")).toBeVisible();
  await modal(page).getByRole("button", { name: "Cancel" }).click();
  await expect(editor.locator("textarea")).toHaveValue("changed but not saved\n");
  await editor.getByRole("button", { name: "Close" }).click();
  await modal(page).getByRole("button", { name: "Discard changes" }).click();
  await expect(page.locator(".modal")).toHaveCount(0);
  expect(readFileSync(path.join(FILES, "notes.txt"), "utf8")).toBe("A file for the browser tests.\n");
  // An untouched file closes at once.
  await page.locator(".file-explorer-open", { hasText: "notes.txt" }).click();
  await expect(editor).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal")).toHaveCount(0);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("the pages are in a menu under a top bar that stays in view", async ({ page }) => {
    await page.goto("/");
    await expect(heading(page, "Overview")).toBeVisible();
    const nav = page.getByRole("navigation");
    const toggle = page.getByRole("button", { name: "Open the menu" });
    await expect(nav).toBeHidden();
    // The open menu takes the focus to the current page; Escape gives it back.
    await toggle.click();
    await expect(nav.getByRole("button", { name: "Overview" })).toBeFocused();
    await expect(nav.getByRole("button", { name: "Overview" })).toHaveAttribute("aria-current", "page");
    await page.keyboard.press("Escape");
    await expect(nav).toBeHidden();
    await expect(toggle).toBeFocused();
    // Choosing a page opens it and closes the menu, and so does a press beside the menu.
    await toggle.click();
    await nav.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(heading(page, "Settings")).toBeVisible();
    await expect(nav).toBeHidden();
    await toggle.click();
    await page.mouse.click(195, 830);
    await expect(nav).toBeHidden();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(toggle).toBeInViewport();
  });

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

// Last, because the dashboard manages no server while this test runs.
test("an administrator corrects the connection from the reconnect screen", async ({ page }) => {
  const settings = path.join(DATA, "server-settings.json");
  await page.goto("/");
  await expect(heading(page, "Overview")).toBeVisible();
  // As if the server's address had changed: nothing answers at the stored target.
  const saved = (await (await page.request.get("/api/settings/server")).json()) as Record<string, unknown>;
  writeFileSync(settings, JSON.stringify({ ...saved, sshTarget: "nobody@127.0.0.1", sshPort: 9 }));
  try {
    await page.reload();
    await expect(page.getByRole("heading", { name: "Server unavailable" })).toBeVisible({ timeout: 30000 });
    await page.getByText("Change the connection settings").click();
    const target = page.getByLabel("SSH target");
    await expect(target).toHaveValue("nobody@127.0.0.1");
    // A target that does not answer is refused, and the stored one stays.
    await target.fill("nobody@127.0.0.2");
    await page.getByRole("button", { name: "Save and test connection" }).click();
    await expect(page.locator(".reconnect-settings .alert")).toBeVisible({ timeout: 30000 });
    expect(JSON.parse(readFileSync(settings, "utf8")).sshTarget).toBe("nobody@127.0.0.1");
    await target.fill("");
    await page.getByLabel("SSH port").fill("22");
    await page.getByRole("button", { name: "Save and test connection" }).click();
    await expect(heading(page, "Overview")).toBeVisible({ timeout: 30000 });
  } finally {
    writeFileSync(settings, JSON.stringify(saved));
  }
});
