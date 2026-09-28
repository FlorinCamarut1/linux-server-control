import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { loadApi, loadServer } from "./harness.mjs";

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
  const { server, readJson } = loadServer();
  const { auth } = loadApi(server);
  await auth.publicRoutes["GET setup/status"]({ req: request("setup/status"), body: {} });
  const setupToken = readJson("setup-bootstrap").code;
  const response = await auth.publicRoutes["POST setup"]({ req: request("setup"), body: { setupToken, username: "admin", password: PASSWORD, confirmPassword: PASSWORD, scriptRoot: "/srv/scripts", allowedPaths: "/srv/scripts", remoteLogs: "/srv/logs" } });
  assert.equal(response.status, 200);
  return { server, auth, readJson, device: cookieOf(response, "lsc_device"), session: cookieOf(response, "lsc_session") };
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
