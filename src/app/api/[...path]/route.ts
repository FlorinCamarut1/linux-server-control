import { NextRequest } from "next/server";
import { CommandError } from "@/lib/server";
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
  if (!sameOrigin(req)) return fail("Invalid request origin", 403);
  let body: Body = {};
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed;
  } catch {}
  return handle(req, `POST ${(await params).path.join("/")}`, body);
}

async function handle(req: NextRequest, route: string, body: Body) {
  try {
    const open = publicRoutes[route];
    if (open) return await open({ req, body });
    // Authenticate before resolving the route, so unknown paths do not reveal
    // which routes exist to signed-out clients.
    const signedIn = authenticate(req);
    if (!signedIn) return fail("Sign in to continue", 401);
    const handler = routes[route];
    if (!handler) return fail("Not found", 404);
    if (!permitted(route, signedIn.user.role, body)) return fail("This account is read-only.", 403);
    return await handler({ req, body, ...signedIn });
  } catch (error) {
    if (error instanceof CommandError) return fail(error.message, 502);
    return fail(error instanceof Error ? error.message : "Internal error");
  }
}
