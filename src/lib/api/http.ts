import { NextRequest, NextResponse } from "next/server";
import type { Session } from "@/lib/server";

export type Body = Record<string, string>;
export type Devices = Record<string, { name: string; created: string }>;
export type PublicContext = { req: NextRequest; body: Body };
export type Context = PublicContext & { sid: string; session: Session; devices: Devices };
export type Handler<C> = (context: C) => Response | Promise<Response>;
// Keyed by "METHOD path", for example "POST schedule/save".
export type Routes<C> = Record<string, Handler<C>>;

export function fail(error: string, status = 400, headers?: HeadersInit) {
  return NextResponse.json({ error }, { status, headers });
}
export function ok(data: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: true, ...data });
}

export const SESSION_SECONDS = 8 * 60 * 60;
const DEVICE_SECONDS = 365 * 24 * 60 * 60;
export function setAuthCookies(response: NextResponse, session: string, device?: string) {
  const options = { httpOnly: true, secure: process.env.COOKIE_SECURE === "true", sameSite: "strict" as const, path: "/" };
  response.cookies.set("lsc_session", session, { ...options, maxAge: SESSION_SECONDS });
  if (device) response.cookies.set("lsc_device", device, { ...options, maxAge: DEVICE_SECONDS });
  return response;
}

// POST requests must come from the dashboard's own origin.
export function sameOrigin(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const publicOrigin = `${forwardedProto || req.nextUrl.protocol.replace(":", "")}://${forwardedHost || req.headers.get("host")}`;
  return origin === publicOrigin;
}
