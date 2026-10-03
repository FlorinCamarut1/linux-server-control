import { NextRequest } from "next/server";
import { CommandError, asActor, inLanguage, t } from "@/lib/server";
import { authenticate, permitted, publicRoutes } from "@/lib/api/auth";
import { type Body, fail, sameOrigin } from "@/lib/api/http";
import { routes } from "@/lib/api/routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, { params }: Params) {
  return handle(req, `GET ${(await params).path.join("/")}`, {});
}
export async function POST(req: NextRequest, { params }: Params) {
  if (!sameOrigin(req)) return inLanguage(req.headers.get("x-lsc-language"), () => fail(t("Invalid request origin"), 403));
  let body: Body = {};
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed;
  } catch {}
  return handle(req, `POST ${(await params).path.join("/")}`, body);
}

// Answers, errors included, are in the language the browser sends.
function handle(req: NextRequest, route: string, body: Body) {
  return inLanguage(req.headers.get("x-lsc-language"), () => answer(req, route, body));
}
async function answer(req: NextRequest, route: string, body: Body) {
  try {
    const open = publicRoutes[route];
    if (open) return await open({ req, body });
    // Authenticate before resolving the route, so unknown paths do not reveal
    // which routes exist to signed-out clients.
    const signedIn = authenticate(req);
    if (!signedIn) return fail(t("Sign in to continue"), 401);
    const handler = routes[route];
    if (!handler) return fail(t("Not found"), 404);
    if (!permitted(route, signedIn.user.role, body)) return fail(t("This account is read-only."), 403);
    return await asActor(signedIn.user.name, () => handler({ req, body, ...signedIn }));
  } catch (error) {
    if (error instanceof CommandError) return fail(error.message, 502);
    return fail(error instanceof Error ? error.message : t("Internal error"));
  }
}
