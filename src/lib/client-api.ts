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
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const data = await response.json();
    if (!response.ok) throw new ApiError(data.error || "Request failed", response.status, data.code);
    return data;
  } finally {
    if (!silent && typeof window !== "undefined")
      window.dispatchEvent(new Event("media-control-request-end"));
  }
}
