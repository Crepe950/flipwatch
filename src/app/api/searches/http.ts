import type { z } from "zod";

const MAX_BODY_BYTES = 64 * 1024;

export function jsonError(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error, ...extra }, { status, headers: { "Cache-Control": "no-store" } });
}

/** Parse a JSON request body (≤ 64 KB). Returns a Response to send back on failure. */
export async function readJson(request: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return { ok: false, response: jsonError(415, "Send a JSON body with Content-Type: application/json") };
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { ok: false, response: jsonError(413, "Request body too large") };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, response: jsonError(400, "Invalid JSON") };
  }
}

export function validationError(error: z.ZodError): Response {
  return jsonError(400, "Validation failed", {
    issues: error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message })),
  });
}
