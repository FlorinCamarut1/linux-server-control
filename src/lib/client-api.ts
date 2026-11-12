import { language, t } from "./i18n";
import type { St } from "./types";

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

// Sent when a request that the page shows as work starts, with the request as
// its detail, and when it ends: a button waits for the requests it started.
export const REQUEST_START = "media-control-request-start", REQUEST_END = "media-control-request-end";
export function api(path: string, body?: unknown, silent = false) {
  return shown(send(path, body), silent);
}
function shown<T>(request: Promise<T>, silent: boolean) {
  if (!silent && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(REQUEST_START, { detail: request }));
    request.catch(() => {}).finally(() => window.dispatchEvent(new Event(REQUEST_END)));
  }
  return request;
}
// A read that says which version of the answer the page holds: the server
// sends nothing back while that version is still the current one.
export function stateIfChanged(path: string, held: string | undefined, silent = false) {
  return shown((async (): Promise<{ data?: St; version?: string }> => {
    const response = await ask(path, undefined, held ? { "if-none-match": held } : {});
    if (response.status === 304) return { version: held };
    return { data: await answer(response), version: response.headers.get("etag") ?? undefined };
  })(), silent);
}
function ask(path: string, body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return fetch(`/api/${path}`, {
    method: body ? "POST" : "GET",
    // The server answers, errors included, in the browser's language.
    headers: { ...(body ? { "content-type": "application/json" } : {}), "x-lsc-language": language(), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal,
  });
}
async function answer(response: Response) {
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error || t("Request failed"), response.status, data.code);
  return data;
}
async function send(path: string, body?: unknown) {
  return answer(await ask(path, body));
}
// Reads an answer that arrives as it is written, such as a log being followed,
// and gives each piece of text to `piece`. Ends when the server ends the answer
// or `signal` is aborted.
export async function apiStream(path: string, signal: AbortSignal, piece: (text: string) => void) {
  const response = await ask(path, undefined, {}, signal);
  if (!response.ok || !response.body) return void await answer(response);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    piece(decoder.decode(value, { stream: true }));
  }
}
