import { language, t } from "./i18n";

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

// Sent when a request that the page shows as work starts, with the request as
// its detail, and when it ends: a button waits for the requests it started.
export const REQUEST_START = "media-control-request-start", REQUEST_END = "media-control-request-end";
export function api(path: string, body?: unknown, silent = false) {
  const request = send(path, body);
  if (!silent && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(REQUEST_START, { detail: request }));
    request.catch(() => {}).finally(() => window.dispatchEvent(new Event(REQUEST_END)));
  }
  return request;
}
async function send(path: string, body?: unknown) {
  const response = await fetch(`/api/${path}`, {
    method: body ? "POST" : "GET",
    // The server answers, errors included, in the browser's language.
    headers: { ...(body ? { "content-type": "application/json" } : {}), "x-lsc-language": language() },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error || t("Request failed"), response.status, data.code);
  return data;
}
