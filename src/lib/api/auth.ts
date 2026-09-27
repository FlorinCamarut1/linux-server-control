import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import {
  audit,
  digest,
  hash,
  persistSessions,
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
  type Context,
  type Devices,
  type PublicContext,
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

function startSession(device: string) {
  const id = token();
  sessions.set(id, { device, expires: Date.now() + SESSION_SECONDS * 1000, created: Date.now() });
  persistSessions();
  return id;
}
const devices = () => read<Devices>("devices", {});

// Returns the signed-in context, or null when the request needs to sign in.
export function authenticate(req: NextRequest) {
  const sid = req.cookies.get("lsc_session")?.value || "";
  const session = sessions.get(sid);
  const known = devices();
  if (
    !session ||
    session.expires < Date.now() ||
    (session.device === "demo"
      ? process.env.NODE_ENV !== "development"
      : !known[session.device])
  )
    return null;
  return { sid, session, devices: known };
}

async function setupStatus() {
  const config = read<Record<string, string>>("config", {});
  if (!config.password) {
    const bootstrap = read<{ code?: string }>("setup-bootstrap", {});
    if (!bootstrap.code) {
      const code = randomBytes(12).toString("base64url");
      save("setup-bootstrap", { code });
      console.log(`\nInitial setup token: ${code}\n`);
    }
  }
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
  try {
    updateServerSettings({
      sshTarget: body.sshTarget || "",
      scriptRoot: body.scriptRoot || "/home",
      allowedPaths: (body.allowedPaths || body.scriptRoot || "/home").split(","),
      remoteLogs: body.remoteLogs || "/tmp/media-dashboard",
    });
    await testServerConnection();
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
  const session = startSession(deviceDigest);
  audit("initial setup completed");
  return setAuthCookies(NextResponse.json({ ok: true }), session, device);
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
  const config = read<Record<string, string>>("config", {});
  // Both checks always run, so the response time does not reveal the username.
  const passwordMatches = secureEqual(
    await hash(body.password || "", config.salt || "00"),
    config.password || "",
  );
  if (!secureEqual(body.username || "", config.username || "") || !passwordMatches)
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
  const session = startSession(digest(device));
  audit("login");
  return setAuthCookies(NextResponse.json({ ok: true }), session, device);
}

export const publicRoutes: Routes<PublicContext> = {
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
  "POST account/password": async ({ body, sid }) => {
    const config = read<Record<string, string>>("config", {});
    if (
      !secureEqual(
        await hash(body.currentPassword || "", config.salt || "00"),
        config.password || "",
      )
    )
      return fail("The current password is incorrect.", 401);
    if ((body.newPassword || "").length < 12)
      return fail("The new password must contain at least 12 characters.");
    if (body.newPassword !== body.confirmPassword)
      return fail("The new passwords do not match.");
    const salt = randomBytes(16).toString("hex");
    save("config", {
      ...config,
      salt,
      password: await hash(body.newPassword, salt),
    });
    for (const key of sessions.keys()) if (key !== sid) sessions.delete(key);
    persistSessions();
    audit("password changed");
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
    const name = known[body.id].name;
    delete known[body.id];
    save("devices", known);
    audit(`device revoked ${name} (${body.id.slice(0, 12)})`);
    return ok();
  },
};
