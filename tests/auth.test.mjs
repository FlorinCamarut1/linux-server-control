import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadApi, loadServer, plain } from "./harness.mjs";

// The same CommonJS instance the modules under test load.
const { NextRequest } = createRequire(import.meta.url)("next/server");

const PASSWORD = "correct-horse-battery";
function request(path, { body, cookies = {} } = {}) {
  const cookie = Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join("; ");
  return new NextRequest(`http://dashboard.test/api/${path}`, { method: body ? "POST" : "GET", headers: cookie ? { cookie } : {} });
}
const cookieOf = (response, name) => response.cookies.get(name)?.value;

// A configured dashboard with one enrolled browser, set up through the real setup route.
async function configured() {
  const { server, readJson, data } = loadServer();
  const { auth } = loadApi(server);
  await auth.publicRoutes["GET setup/status"]({ req: request("setup/status"), body: {} });
  const setupToken = readJson("setup-bootstrap").code;
  const response = await auth.publicRoutes["POST setup"]({ req: request("setup"), body: { setupToken, username: "admin", password: PASSWORD, confirmPassword: PASSWORD, scriptRoot: "/srv/scripts", allowedPaths: "/srv/scripts", remoteLogs: "/srv/logs" } });
  assert.equal(response.status, 200);
  return { server, auth, readJson, data, device: cookieOf(response, "lsc_device"), session: cookieOf(response, "lsc_session") };
}
const login = (auth, body, cookies) => auth.publicRoutes["POST login"]({ req: request("login", { body, cookies }), body });

test("setup requires the bootstrap token and runs only once", async () => {
  const { server, readJson } = loadServer();
  const { auth } = loadApi(server);
  const status = await (await auth.publicRoutes["GET setup/status"]({ req: request("setup/status"), body: {} })).json();
  assert.equal(status.configured, false);
  const body = { setupToken: "wrong", username: "admin", password: PASSWORD, confirmPassword: PASSWORD };
  assert.equal((await auth.publicRoutes["POST setup"]({ req: request("setup"), body })).status, 403);
  body.setupToken = readJson("setup-bootstrap").code;
  assert.equal((await auth.publicRoutes["POST setup"]({ req: request("setup"), body: { ...body, password: "short", confirmPassword: "short" } })).status, 400);
  assert.equal((await auth.publicRoutes["POST setup"]({ req: request("setup"), body })).status, 200);
  assert.equal((await auth.publicRoutes["POST setup"]({ req: request("setup"), body })).status, 409);
  const after = await (await auth.publicRoutes["GET setup/status"]({ req: request("setup/status"), body: {} })).json();
  assert.deepEqual(after, { configured: true }, "connection details are hidden once configured");
});

test("an enrolled browser signs in, and a wrong password is rejected", async () => {
  const { auth, device } = await configured();
  const ok = await login(auth, { username: "admin", password: PASSWORD }, { lsc_device: device });
  assert.equal(ok.status, 200);
  assert.ok(cookieOf(ok, "lsc_session"));
  assert.equal((await login(auth, { username: "admin", password: "nope" }, { lsc_device: device })).status, 401);
  assert.equal((await login(auth, { username: "someone", password: PASSWORD }, { lsc_device: device })).status, 401);
});

test("a new browser needs an enrollment code before its password is checked", async () => {
  const { auth, server, readJson } = await configured();
  const withoutCode = await login(auth, { username: "admin", password: PASSWORD });
  assert.equal(withoutCode.status, 403, "a correct password alone does not reveal itself");
  server.save("enroll", { code: "code-123", expires: Date.now() / 1000 + 600 });
  const enrolled = await login(auth, { username: "admin", password: PASSWORD, code: "code-123", deviceName: "Phone" });
  assert.equal(enrolled.status, 200);
  assert.ok(cookieOf(enrolled, "lsc_device"));
  assert.equal(Object.keys(readJson("devices")).length, 2);
  assert.deepEqual(readJson("enroll"), {}, "the code works once");
  server.save("enroll", { code: "old", expires: Date.now() / 1000 - 1 });
  assert.equal((await login(auth, { username: "admin", password: PASSWORD, code: "old" })).status, 403, "expired codes are refused");
});

test("repeated failures block the browser but not other enrolled browsers", async () => {
  const { auth, server, device } = await configured();
  for (let attempt = 1; attempt < 5; attempt++) assert.equal((await login(auth, { username: "admin", password: "x" }, { lsc_device: device })).status, 401);
  const blocked = await login(auth, { username: "admin", password: "x" }, { lsc_device: device });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  assert.equal((await login(auth, { username: "admin", password: PASSWORD }, { lsc_device: device })).status, 429, "blocked even with the right password");
  // Guessing from unknown browsers uses its own bucket.
  server.save("enroll", { code: "code-2", expires: Date.now() / 1000 + 600 });
  for (let attempt = 0; attempt < 10; attempt++) await login(auth, { username: "admin", password: "x" });
  assert.equal((await login(auth, { username: "admin", password: "x" })).status, 429);
});

test("sessions end on logout, expiry, device revocation and password change", async () => {
  const { auth, server, device, session } = await configured();
  const signedIn = (sid) => auth.authenticate(request("state", { cookies: { lsc_session: sid } }));
  assert.ok(signedIn(session));
  const second = cookieOf(await login(auth, { username: "admin", password: PASSWORD }, { lsc_device: device }), "lsc_session");
  const context = signedIn(session);
  const changed = await auth.accountRoutes["POST account/password"]({ ...context, req: request("account/password", { body: {} }), body: { currentPassword: PASSWORD, newPassword: "another-long-password", confirmPassword: "another-long-password" } });
  assert.equal(changed.status, 200);
  assert.equal(signedIn(second), null, "other sessions end when the password changes");
  assert.ok(signedIn(session), "the current session stays");
  await auth.accountRoutes["POST logout"]({ ...signedIn(session), req: request("logout", { body: {} }), body: {} });
  assert.equal(signedIn(session), null);
  const third = cookieOf(await login(auth, { username: "admin", password: "another-long-password" }, { lsc_device: device }), "lsc_session");
  server.sessions.get(third).expires = Date.now() - 1;
  assert.equal(signedIn(third), null, "expired");
  const fourth = cookieOf(await login(auth, { username: "admin", password: "another-long-password" }, { lsc_device: device }), "lsc_session");
  server.save("devices", {});
  assert.equal(signedIn(fourth), null, "revoked device");
  server.sessions.set("demo-session", { device: "demo", expires: Date.now() + 60000, created: Date.now() });
  assert.equal(signedIn("demo-session"), null, "demo sessions are refused outside development");
});

test("read-only accounts sign in but may only read", async () => {
  const { auth, server, device, session, readJson } = await configured();
  const owner = auth.authenticate(request("state", { cookies: { lsc_session: session } }));
  assert.deepEqual(plain(owner.user), { name: "admin", role: "admin" });
  const save = (body) => auth.accountRoutes["POST users/save"]({ ...owner, req: request("users/save", { body }), body });
  assert.equal((await save({ username: "guest", role: "viewer", password: "short" })).status, 400);
  assert.equal((await save({ username: "admin", role: "viewer", password: "another-long-password" })).status, 400, "the owner cannot be demoted");
  assert.equal((await save({ username: "bad name", role: "viewer", password: "another-long-password" })).status, 400);
  assert.equal((await save({ username: "guest", role: "viewer", password: "guest-long-password" })).status, 200);
  assert.ok(!JSON.stringify(readJson("users")).includes("guest-long-password"), "only the hash is stored");

  const guestSession = cookieOf(await login(auth, { username: "guest", password: "guest-long-password" }, { lsc_device: device }), "lsc_session");
  const guest = auth.authenticate(request("state", { cookies: { lsc_session: guestSession } }));
  assert.deepEqual(plain(guest.user), { name: "guest", role: "viewer" });
  for (const route of ["GET state", "GET history/runs", "POST script/log", "POST logout", "POST account/password"])
    assert.ok(auth.permitted(route, "viewer", {}), route);
  for (const route of ["POST script/run", "POST file/save", "POST file/browse", "POST schedule/save", "POST users/save", "GET users", "GET config/export", "POST settings/server", "POST enrollment/create", "POST device/revoke", "GET preflight", "GET notifications"])
    assert.ok(!auth.permitted(route, "viewer", {}), route);
  assert.ok(auth.permitted("POST container", "viewer", { action: "logs" }));
  assert.ok(!auth.permitted("POST container", "viewer", { action: "stop" }));
  assert.ok(auth.permitted("POST script/run", "admin", {}));

  // A viewer changes its own password without touching the owner's.
  const changed = await auth.accountRoutes["POST account/password"]({ ...guest, req: request("account/password", { body: {} }), body: { currentPassword: "guest-long-password", newPassword: "guest-newer-password", confirmPassword: "guest-newer-password" } });
  assert.equal(changed.status, 200);
  assert.ok(auth.authenticate(request("state", { cookies: { lsc_session: session } })), "the owner stays signed in");
  assert.equal((await login(auth, { username: "admin", password: PASSWORD }, { lsc_device: device })).status, 200);
  assert.equal((await login(auth, { username: "guest", password: "guest-long-password" }, { lsc_device: device })).status, 401);

  // Promotion takes effect on the next request; deletion signs the account out.
  await save({ username: "guest", role: "admin" });
  assert.equal(auth.authenticate(request("state", { cookies: { lsc_session: guestSession } })).user.role, "admin");
  assert.equal((await login(auth, { username: "guest", password: "guest-newer-password" }, { lsc_device: device })).status, 200, "an edit without a password keeps it");
  const remove = (username) => auth.accountRoutes["POST users/delete"]({ ...owner, req: request("users/delete", { body: {} }), body: { username } });
  assert.equal((await remove("admin")).status, 404, "the owner is not a deletable account");
  assert.equal((await remove("guest")).status, 200);
  assert.equal(auth.authenticate(request("state", { cookies: { lsc_session: guestSession } })), null);
  assert.equal([...server.sessions.values()].filter((item) => item.user === "guest").length, 0);
});

test("the only authorized browser cannot be revoked", async () => {
  const { auth, server, session, readJson } = await configured();
  const context = () => auth.authenticate(request("state", { cookies: { lsc_session: session } }));
  const revoke = (id) => auth.accountRoutes["POST device/revoke"]({ ...context(), req: request("device/revoke", { body: {} }), body: { id } });
  const [own] = Object.keys(readJson("devices"));
  const refused = await revoke(own);
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /only authorized browser/);
  assert.ok(context(), "still signed in");
  // With a second browser enrolled, either may be revoked.
  server.save("enroll", { code: "code-123", expires: Date.now() / 1000 + 600 });
  await login(auth, { username: "admin", password: PASSWORD, code: "code-123", deviceName: "Phone" });
  assert.equal(Object.keys(readJson("devices")).length, 2);
  assert.equal((await revoke(own)).status, 200);
  assert.deepEqual(Object.keys(readJson("devices")).length, 1);
  assert.equal(context(), null, "the revoked browser is signed out");
});

// The two commands INSTALL.md gives for a dashboard nobody can sign in to.
test("the recovery scripts reset the owner's password and enroll a browser", async () => {
  const { auth, readJson, data } = await configured();
  const script = (name, env = {}) => execFileSync(process.execPath, [fileURLToPath(new URL(`../scripts/${name}`, import.meta.url))], { env: { ...process.env, DATA_DIR: data, DASHBOARD_USER: "", ...env }, encoding: "utf8", stdio: "pipe" });
  assert.throws(() => script("setup.mjs", { DASHBOARD_PASSWORD: "short" }), /at least 12 characters/);
  script("setup.mjs", { DASHBOARD_PASSWORD: "a-new-long-password" });
  assert.equal(readJson("config").username, "admin", "the username is kept");
  const code = script("enroll.mjs").trim().split(": ")[1];
  assert.equal((await login(auth, { username: "admin", password: PASSWORD, code })).status, 401, "the forgotten password is gone");
  const recovered = await login(auth, { username: "admin", password: "a-new-long-password", code, deviceName: "Recovered" });
  assert.equal(recovered.status, 200);
  assert.equal(Object.keys(readJson("devices")).length, 2);
  script("setup.mjs", { DASHBOARD_PASSWORD: "another-long-password", DASHBOARD_USER: "owner" });
  assert.equal(readJson("config").username, "owner", "DASHBOARD_USER names another username");
});

test("sessions from before accounts existed belong to the owner", async () => {
  const { auth, server, session } = await configured();
  delete server.sessions.get(session).user;
  assert.deepEqual(plain(auth.authenticate(request("state", { cookies: { lsc_session: session } })).user), { name: "admin", role: "admin" });
});
