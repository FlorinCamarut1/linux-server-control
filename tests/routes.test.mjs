import assert from "node:assert/strict";
import test from "node:test";
import { loadRoutes, loadServer, plain, snapshotAnswer } from "./harness.mjs";

// A context like the one the catch-all route passes to a handler.
const context = (role, path = "/api/state", body = {}) => ({
  req: { nextUrl: new URL(`http://dashboard${path}`) }, body, sid: "s", session: { device: "d" }, devices: {}, user: { name: role, role },
});
const answer = async (response) => plain(await response.json());

test("a read-only account is sent neither the scripts' variables nor the crontabs", async () => {
  const crontab = "0 3 * * * env 'TOKEN=secret' /bin/bash '/srv/scripts/backup.sh' # media-dashboard:a\n";
  const { server } = loadServer({ host: (argv) => snapshotAnswer(argv, { cron: crontab, rootCron: crontab, rootSystem: crontab }) });
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
    if (argv[3] === "resolve") return { stdout: "file\n" + argv.at(-1) };
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

// A request with headers, as a refresh that names the version it holds sends.
const asking = (role, path, headers = {}) => ({ ...context(role, path), req: { nextUrl: new URL(`http://dashboard${path}`), headers: new Headers(headers) } });

test("an opening page is sent the snapshot the dashboard kept, without a host read", async () => {
  const crontab = "0 3 * * * env 'TOKEN=secret' /bin/bash '/srv/scripts/backup.sh' # media-dashboard:a\n";
  const { server, commands } = loadServer({ host: (argv) => snapshotAnswer(argv, { cron: crontab, stats: "cpuUsagePercent=12.5\ntime=27.09.2026 03:00:00 EEST\n", docker: '{"Names":"example","State":"exited"}\n' }) });
  const { routes } = loadRoutes(server);
  const first = await answer(await routes["GET state"](asking("admin", "/api/state?scope=kept")));
  assert.equal(commands.length, 1, "nothing is kept yet, so the server is read");
  assert.equal(first.keptAt, undefined, "and what is sent is the server as it is now");
  const opening = await answer(await routes["GET state"](asking("admin", "/api/state?scope=kept")));
  assert.equal(commands.length, 1, "the kept snapshot needs no host command");
  assert.equal(typeof opening.keptAt, "number");
  assert.equal(opening.containers[0].Names, "example");
  assert.equal(opening.time, "27.09.2026 03:00:00 EEST", "it says when it was read");
  assert.equal(opening.cron, crontab);
  assert.equal(opening.alertState.values.stoppedContainers, 1);
  assert.equal(opening.cronLog, undefined);
  const viewer = await answer(await routes["GET state"](asking("viewer", "/api/state?scope=kept")));
  assert.ok(!JSON.stringify(viewer).includes("secret"), "a read-only account is not sent the crontabs from it either");
  // A change made through the dashboard must not be shown as it was before.
  server.forgetKeptSnapshot();
  await routes["GET state"](asking("admin", "/api/state?scope=kept"));
  assert.equal(commands.length, 2);
  // Nor is another server's snapshot shown for the one now managed.
  server.updateServerSettings({ sshTarget: "admin@other" });
  assert.equal(server.keptSnapshot(), undefined);
});

test("a refresh that holds the current version is sent nothing", async () => {
  const { server } = loadServer();
  server.save("scripts", [{ id: "a", name: "Backup", path: "/srv/scripts/backup.sh", cron: "" }]);
  const { routes } = loadRoutes(server);
  const first = await routes["GET state"](asking("admin", "/api/state?scope=records"));
  const version = first.headers.get("etag");
  assert.match(version, /^"[0-9a-f]{32}"$/);
  const again = await routes["GET state"](asking("admin", "/api/state?scope=records", { "if-none-match": version }));
  assert.equal(again.status, 304);
  assert.equal(await again.text(), "");
  // A proxy that compresses the answer marks the version as weak.
  assert.equal((await routes["GET state"](asking("admin", "/api/state?scope=records", { "if-none-match": `W/${version}` }))).status, 304);
  server.save("scripts", [{ id: "a", name: "Backup renamed", path: "/srv/scripts/backup.sh", cron: "" }]);
  const changed = await routes["GET state"](asking("admin", "/api/state?scope=records", { "if-none-match": version }));
  assert.equal(changed.status, 200);
  assert.equal((await answer(changed)).scripts[0].name, "Backup renamed");
  assert.notEqual(changed.headers.get("etag"), version);
});
