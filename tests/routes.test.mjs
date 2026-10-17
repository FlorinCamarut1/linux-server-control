import assert from "node:assert/strict";
import test from "node:test";
import { loadRoutes, loadServer, plain } from "./harness.mjs";

// A context like the one the catch-all route passes to a handler.
const context = (role, path = "/api/state", body = {}) => ({
  req: { nextUrl: new URL(`http://dashboard${path}`) }, body, sid: "s", session: { device: "d" }, devices: {}, user: { name: role, role },
});
const answer = async (response) => plain(await response.json());

test("a read-only account is sent neither the scripts' variables nor the crontabs", async () => {
  const crontab = "0 3 * * * env 'TOKEN=secret' /bin/bash '/srv/scripts/backup.sh' # media-dashboard:a\n";
  const { server } = loadServer({ host: (argv) => ({ stdout: argv[0] === "crontab" ? crontab : argv.includes("list") || argv.includes("system-list") ? crontab : "" }) });
  server.save("scripts", [{ id: "a", name: "Backup", path: "/srv/scripts/backup.sh", cron: "", variables: { TOKEN: "secret" } }]);
  const { routes } = loadRoutes(server);
  const admin = await answer(await routes["GET state"](context("admin")));
  assert.equal(admin.scripts[0].variables.TOKEN, "secret");
  assert.equal(admin.cron, crontab);
  for (const path of ["/api/state", "/api/state?scope=records"]) {
    const viewer = await answer(await routes["GET state"](context("viewer", path)));
    assert.equal(viewer.scripts[0].variables, undefined, path);
    assert.equal(viewer.scripts[0].name, "Backup");
    assert.ok(!JSON.stringify(viewer).includes("secret"), `${path} carries no secret`);
  }
});

test("editing a scheduled script writes its schedules' crontab lines again", async () => {
  let crontab = "";
  const host = (argv, input) => {
    if (argv[0] === "realpath") return { stdout: argv.at(-1) + "\n" };
    if (argv[0] === "crontab" && argv[1] === "-l") return { stdout: crontab };
    if (argv[0] === "crontab" && argv[1] === "-") crontab = input;
    return { stdout: "" };
  };
  const { server } = loadServer({ host });
  server.save("scripts", [{ id: "a", name: "Backup", path: "/srv/scripts/old.sh", cron: "" }]);
  server.save("schedules", [{ id: "s", scriptId: "a", expression: "0 3 * * *", label: "Nightly", enabled: true, runAs: "user" }]);
  const { routes } = loadRoutes(server);
  await routes["POST script/save"](context("admin", "/api/script/save", { id: "a", name: "Backup", path: "/srv/scripts/new.sh", runAs: "user", variables: "KEEP=3", runOptions: "[]" }));
  assert.match(crontab, /\/srv\/scripts\/new\.sh/);
  assert.match(crontab, /KEEP=3/);
  assert.doesNotMatch(crontab, /old\.sh/);
});
