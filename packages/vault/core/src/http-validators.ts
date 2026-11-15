/**
 * HEAD and validators for one record's REST answer (0.9.3, T-463), one copy for every door (a box's routes.ts and the
 * cloud vault worker). Web-standard only (Response, WebCrypto), so it runs under Bun and workerd alike.
 */

/** A HEAD answer made from a GET answer: its status and headers, a Content-Length for the body it holds back. */
export async function headOf(res: Response): Promise<Response> {
  const h = new Headers(res.headers);
  h.set("content-length", String((await res.arrayBuffer()).byteLength));
  return new Response(null, { status: res.status, statusText: res.statusText, headers: h });
}

/**
 * Validators for one record's answer: a strong ETag (a hash of the answer's own bytes, so it changes with any change
 * to the representation this key is shown: body, fields, tags in scope, links, query options) and Last-Modified (the
 * record's update time; the ETag, not this, is what catches a tag-only change). A 200 JSON answer only.
 */
export async function withValidators(res: Response): Promise<Response> {
  if (res.status !== 200 || !(res.headers.get("content-type") ?? "").includes("application/json")) return res;
  const bytes = await res.arrayBuffer();
  const h = new Headers(res.headers);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  h.set("etag", `"${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32)}"`);
  try {
    const doc = JSON.parse(new TextDecoder().decode(bytes)) as { updatedAt?: string; updated_at?: string };
    const at = Date.parse(doc.updatedAt ?? doc.updated_at ?? "");
    if (!Number.isNaN(at)) h.set("last-modified", new Date(at).toUTCString());
  } catch {}
  return new Response(bytes, { status: res.status, statusText: res.statusText, headers: h });
}
