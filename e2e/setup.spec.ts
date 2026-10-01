import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { ADMIN_STATE, DATA, PASSWORD, USERNAME } from "./paths";

test("first run: the setup form creates the account and opens the dashboard", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Set up Linux Server Control" })).toBeVisible();

  await page.getByLabel("Setup token").fill("not-the-token");
  await page.getByLabel("Username").fill(USERNAME);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByText("The setup token is incorrect.")).toBeVisible();

  // The token is printed to the container log and stored next to the data.
  const token = JSON.parse(readFileSync(path.join(DATA, "setup-bootstrap.json"), "utf8")).code;
  await page.getByLabel("Setup token").fill(token);
  await page.getByRole("button", { name: "Finish setup" }).click();

  // A machine that lacks Docker or cron lists what is missing before continuing.
  const proceed = page.getByRole("button", { name: "Continue to the dashboard" });
  const overview = page.getByRole("heading", { name: "Overview", level: 1 });
  await expect(proceed.or(overview)).toBeVisible();
  if (await proceed.isVisible()) {
    await expect(page.getByRole("heading", { name: "Setup complete" })).toBeVisible();
    await proceed.click();
  }
  await expect(overview).toBeVisible();
  await page.context().storageState({ path: ADMIN_STATE });
});
