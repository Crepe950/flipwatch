import type { z } from "zod";

type ParseResult<T> = { ok: true; data: T } | { ok: false; response: Response };

/**
 * Parse a JSON request body with a zod schema. Requiring a JSON content type also blocks
 * cross-site form posts (which can't set it without a CORS preflight).
 */
export async function parseJsonBody<T>(request: Request, schema: z.ZodType<T>): Promise<ParseResult<T>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(contentType)) {
    return { ok: false, response: Response.json({ error: "Expected application/json" }, { status: 415 }) };
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, response: Response.json({ error: "Invalid JSON" }, { status: 400 }) };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return { ok: false, response: Response.json({ error: `Invalid request — ${where}${issue?.message ?? "bad input"}` }, { status: 400 }) };
  }
  return { ok: true, data: parsed.data };
}
