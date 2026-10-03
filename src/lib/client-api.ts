import { language, t } from "./i18n";

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

export async function api(path: string, body?: unknown, silent = false) {
  if (!silent && typeof window !== "undefined")
    window.dispatchEvent(new Event("media-control-request-start"));
  try {
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
  } finally {
    if (!silent && typeof window !== "undefined")
      window.dispatchEvent(new Event("media-control-request-end"));
  }
}
