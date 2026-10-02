import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import {
  announceSetupToken,
  audit,
  digest,
  hash,
  persistSessions,
  preflight,
  type PreflightCheck,
  read,
  save,
  secureEqual,
  serverSettings,
  sessions,
  testServerConnection,
  token,
  updateServerSettings,
} from "@/lib/server";
import {
  type Body,
  type Context,
  type Devices,
  type PublicContext,
  type Role,
  type Routes,
  SESSION_SECONDS,
  fail,
  ok,
  setAuthCookies,
} from "./http";

type LoginAttempt = { failures: number; firstFailure: number; blockedUntil: number };
const loginAttempts = new Map<string, LoginAttempt>();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
// Without a reverse proxy the client address cannot be trusted (clients may send
// their own X-Forwarded-For), so attempts are grouped by what cannot be forged:
// each enrolled browser has its own bucket, and all unknown browsers share one.
// Guessing from new browsers therefore can never lock out an enrolled browser.
const NEW_BROWSER_BUCKET = "new-browser";
function loginLimit(key: string) {
  return key === NEW_BROWSER_BUCKET ? 10 : 5;
}
function blockedFor(key: string) {
  const attempt = loginAttempts.get(key);
  if (!attempt) return 0;
  const now = Date.now();
  if (attempt.blockedUntil > now)
    return Math.ceil((attempt.blockedUntil - now) / 1000);
  if (now - attempt.firstFailure > LOGIN_WINDOW_MS) loginAttempts.delete(key);
  return 0;
}
function recordLoginFailure(key: string) {
  const now = Date.now();
  const previous = loginAttempts.get(key);
  const attempt =
    !previous || now - previous.firstFailure > LOGIN_WINDOW_MS
      ? { failures: 1, firstFailure: now, blockedUntil: 0 }
      : { ...previous, failures: previous.failures + 1 };
  if (attempt.failures >= loginLimit(key))
    attempt.blockedUntil = now + LOGIN_BLOCK_MS;
  loginAttempts.set(key, attempt);
  return attempt.blockedUntil > now;
}
function tooManyAttempts(seconds: number) {
  return fail(
    `Too many sign-in attempts. Try again in ${Math.ceil(seconds / 60)} minute(s).`,
    429,
    { "Retry-After": String(seconds) },
  );
}

function startSession(device: string, user?: string) {
  const id = token();
  sessions.set(id, { device, expires: Date.now() + SESSION_SECONDS * 1000, created: Date.now(), ...(user ? { user } : {}) });
  persistSessions();
  return id;
}
const devices = () => read<Devices>("devices", {});

// The owner created at setup lives in config.json and is always an administrator.
// Further accounts live in users.json, keyed by username.
type StoredUser = { salt: string; password: string; role: Role; created: string };
type Account = { username: string; salt: string; password: string; role: Role; owner: boolean; created?: string };
const USERNAME = /^[a-zA-Z0-9_.-]{1,40}$/;
const storedUsers = () => read<Record<string, StoredUser>>("users", {});
function accounts(): Account[] {
  const config = read<Record<string, string>>("config", {});
  const owner: Account[] = config.password ? [{ username: config.username || "admin", salt: config.salt, password: config.password, role: "admin", owner: true }] : [];
  return [...owner, ...Object.entries(storedUsers()).map(([username, user]) => ({ username, ...user, role: user.role === "admin" ? "admin" as const : "viewer" as const, owner: false }))];
}
// The account a session belongs to; undefined once that account was deleted.
function sessionAccount(user?: string) {
  const all = accounts();
  return user ? all.find((account) => account.username === user) : all.find((account) => account.owner);
}

// What a read-only account may call: reading state, history, power data and logs,
// and managing its own session and password.
const VIEWER_ROUTES = new Set([
  "GET state", "GET history/runs", "GET history/metrics",
  "GET power/drivers", "GET power/devices", "GET power/history",
  "POST script/log", "POST container/size", "POST logout", "POST account/password",
]);
export function permitted(route: string, role: Role, body: Body) {
  if (role === "admin") return true;
  // The container route also starts and stops containers; viewers only read logs.
  if (route === "POST container") return body.action === "logs";
  return VIEWER_ROUTES.has(route);
}

// Returns the signed-in context, or null when the request needs to sign in.
export function authenticate(req: NextRequest) {
  const sid = req.cookies.get("lsc_session")?.value || "";
  const session = sessions.get(sid);
  const known = devices();
  if (!session || session.expires < Date.now()) return null;
  if (session.device === "demo")
    return process.env.NODE_ENV === "development" ? { sid, session, devices: known, user: { name: "demo", role: "admin" as Role } } : null;
  const account = sessionAccount(session.user);
  if (!known[session.device] || !account) return null;
  return { sid, session, devices: known, user: { name: account.username, role: account.role } };
}

async function setupStatus() {
  const config = read<Record<string, string>>("config", {});
  // Normally printed at startup; this covers a data folder emptied while running.
  if (!config.password && !read<{ code?: string }>("setup-bootstrap", {}).code) announceSetupToken();
  // The connection details prefill the setup form; once configured they are
  // only available to signed-in users.
  return NextResponse.json(config.password ? { configured: true } : { configured: false, server: serverSettings() });
}

async function setup({ body }: PublicContext) {
  const existing = read<Record<string, string>>("config", {});
  if (existing.password)
    return fail("Initial setup has already been completed.", 409);
  const bootstrap = read<{ code?: string }>("setup-bootstrap", {});
  if (!bootstrap.code || !secureEqual(body.setupToken || "", bootstrap.code))
    return fail("The setup token is incorrect.", 403);
  const username = (body.username || "admin").trim();
  if (!/^[a-zA-Z0-9_.-]{1,40}$/.test(username))
    return fail("Use a username containing only letters, numbers, dots, dashes or underscores.");
  if ((body.password || "").length < 12)
    return fail("The password must contain at least 12 characters.");
  if (body.password !== body.confirmPassword)
    return fail("The passwords do not match.");

  const previousServerSettings = serverSettings();
  let checks: PreflightCheck[] = [];
  try {
    updateServerSettings({
      sshTarget: body.sshTarget || "",
      ...(body.sshPort ? { sshPort: Number(body.sshPort) } : {}),
      scriptRoot: body.scriptRoot || "/home",
      allowedPaths: (body.allowedPaths || body.scriptRoot || "/home").split(","),
      remoteLogs: body.remoteLogs || "/tmp/media-dashboard",
    });
    await testServerConnection();
    // Missing tools do not block setup; they are listed so they can be installed.
    checks = (await preflight().catch(() => ({ checks: [] }))).checks;
  } catch (error) {
    updateServerSettings(previousServerSettings);
    return fail(`Server connection could not be verified: ${error instanceof Error ? error.message : "unknown error"}`, 400);
  }
  const salt = randomBytes(16).toString("hex");
  save("config", { username, salt, password: await hash(body.password, salt) });
  save("setup-bootstrap", {});
  const device = token();
  const deviceDigest = digest(device);
  save("devices", {
    [deviceDigest]: {
      name: (body.deviceName || "First browser").slice(0, 80),
      created: new Date().toISOString(),
    },
  });
  const session = startSession(deviceDigest, username);
  audit("initial setup completed");
  return setAuthCookies(NextResponse.json({ ok: true, checks }), session, device);
}

async function login({ req, body }: PublicContext) {
  if (
    process.env.NODE_ENV === "development" &&
    body.username === "demo" &&
    body.password === "demo"
  )
    return setAuthCookies(NextResponse.json({ ok: true }), startSession("demo"));
  let device = req.cookies.get("lsc_device")?.value || "";
  const known = devices();
  const enrolled = Boolean(device && known[digest(device)]);
  const attemptKey = enrolled ? `device:${digest(device)}` : NEW_BROWSER_BUCKET;
  const retryAfter = blockedFor(attemptKey);
  if (retryAfter) return tooManyAttempts(retryAfter);
  const rejected = (message: string, status: number) =>
    recordLoginFailure(attemptKey) ? tooManyAttempts(LOGIN_BLOCK_MS / 1000) : fail(message, status);
  // A new browser must present a valid enrollment code before its password is
  // checked, so it cannot learn whether a guessed password is correct.
  const enroll = read<{ code?: string; expires?: number }>("enroll", {});
  if (
    !enrolled &&
    ((enroll.expires || 0) < Date.now() / 1000 ||
      !secureEqual(body.code || "", enroll.code || "invalid"))
  )
    return rejected("New browser: enter an enrollment code generated in the dashboard.", 403);
  const account = accounts().find((item) => item.username === body.username);
  // The hash is always computed, so the response time does not reveal the username.
  const passwordMatches = secureEqual(
    await hash(body.password || "", account?.salt || "00"),
    account?.password || "",
  );
  if (!account || !passwordMatches)
    return rejected("Incorrect username or password", 401);
  if (!enrolled) {
    device = token();
    known[digest(device)] = {
      name: (body.deviceName || "Browser").slice(0, 80),
      created: new Date().toISOString(),
    };
    save("devices", known);
    save("enroll", {});
    audit("device enrolled " + digest(device).slice(0, 12));
  }
  loginAttempts.delete(attemptKey);
  const session = startSession(digest(device), account.username);
  audit("login " + account.username);
  return setAuthCookies(NextResponse.json({ ok: true }), session, device);
}

export const publicRoutes: Routes<PublicContext> = {
  // For the container health check; reveals nothing about the installation.
  "GET health": () => NextResponse.json({ ok: true }),
  "GET setup/status": setupStatus,
  "POST setup": setup,
  "POST login": login,
};

export const accountRoutes: Routes<Context> = {
  "POST logout": ({ sid }) => {
    sessions.delete(sid);
    persistSessions();
    return ok();
  },
  "POST account/password": async ({ body, sid, user }) => {
    const account = accounts().find((item) => item.username === user.name);
    if (
      !account ||
      !secureEqual(
        await hash(body.currentPassword || "", account.salt || "00"),
        account.password || "",
      )
    )
      return fail("The current password is incorrect.", 401);
    if ((body.newPassword || "").length < 12)
      return fail("The new password must contain at least 12 characters.");
    if (body.newPassword !== body.confirmPassword)
      return fail("The new passwords do not match.");
    const salt = randomBytes(16).toString("hex");
    const password = await hash(body.newPassword, salt);
    if (account.owner) save("config", { ...read<Record<string, string>>("config", {}), salt, password });
    else save("users", { ...storedUsers(), [account.username]: { ...storedUsers()[account.username], salt, password } });
    // Close this account's other sessions; other accounts stay signed in.
    for (const [key, session] of sessions)
      if (key !== sid && sessionAccount(session.user)?.username === account.username) sessions.delete(key);
    persistSessions();
    audit("password changed " + account.username);
    return ok();
  },
  "GET users": () =>
    NextResponse.json({ users: accounts().map(({ username, role, owner, created }) => ({ username, role, owner, created })) }),
  // Creates an account, or changes the role and (when given) the password of one.
  "POST users/save": async ({ body, user }) => {
    const username = (body.username || "").trim();
    if (!USERNAME.test(username))
      return fail("Use a username containing only letters, numbers, dots, dashes or underscores.");
    const role: Role = body.role === "admin" ? "admin" : "viewer";
    const existing = accounts().find((item) => item.username === username);
    if (existing?.owner) return fail("The owner account is changed under Change password.");
    if (existing && username === user.name && role !== existing.role) return fail("You cannot change your own role.");
    if (!existing && !body.password) return fail("Enter a password for the new account.");
    if (body.password && body.password.length < 12)
      return fail("The password must contain at least 12 characters.");
    const all = storedUsers();
    let credentials = existing ? { salt: existing.salt, password: existing.password } : { salt: "", password: "" };
    if (body.password) {
      const salt = randomBytes(16).toString("hex");
      credentials = { salt, password: await hash(body.password, salt) };
      // A new password ends the sessions that used the old one.
      for (const [key, session] of sessions) if (session.user === username) sessions.delete(key);
      persistSessions();
    }
    save("users", { ...all, [username]: { ...credentials, role, created: all[username]?.created || new Date().toISOString() } });
    audit(`account ${existing ? "updated" : "created"} ${username} (${role})`);
    return ok();
  },
  "POST users/delete": ({ body, user }) => {
    const all = storedUsers();
    if (!all[body.username]) return fail("Account not found.", 404);
    if (body.username === user.name) return fail("You cannot delete your own account.");
    delete all[body.username];
    save("users", all);
    for (const [key, session] of sessions) if (session.user === body.username) sessions.delete(key);
    persistSessions();
    audit(`account deleted ${body.username}`);
    return ok();
  },
  "POST enrollment/create": ({ body }) => {
    const duration = Number(body.minutes || 15);
    if (![5, 15, 30].includes(duration))
      return fail("Choose a valid code duration.");
    const code = randomBytes(12).toString("base64url");
    const expires = Math.floor(Date.now() / 1000) + duration * 60;
    save("enroll", { code, expires });
    audit(`enrollment code created (${duration} minutes)`);
    return NextResponse.json({ code, expires });
  },
  "POST device/revoke": ({ body, devices: known }) => {
    if (!known[body.id]) throw Error("Device not found");
    // The only authorized browser is the one making this request: without it
    // nobody could create an access code, and no browser could sign in again.
    if (Object.keys(known).length === 1)
      return fail("This is the only authorized browser. Authorize another one before revoking it.");
    const name = known[body.id].name;
    delete known[body.id];
    save("devices", known);
    audit(`device revoked ${name} (${body.id.slice(0, 12)})`);
    return ok();
  },
};
