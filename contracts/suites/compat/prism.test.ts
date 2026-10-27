// compat/prism: what Prism calls, as Prism calls it, must keep its shape (PLAN §3 "Tokens and versions", §6 slice 0,
// §8.3 "nothing he calls changes shape"). Our mirror of Benjamin's suite (prism scripts/parachute-compat/run.mjs:412-526),
// run through the box the candidate adapter starts, plus the parts of Prism's own server that depend on the shapes:
//   - minting: apps/server/src/mcp-token.ts:85-106 (`auth mint-token --scope vault:<n>:<verb> --expires-in <s> --service
//     <sub>`, and `--ephemeral` for admin), parsed the way parachute-cli.ts:363-377 parses stock output (the JWT on the
//     last line);
//   - verifying: apps/server/src/auth/hub-jwt.ts:163-205 (RS256 against <hub>/.well-known/jwks.json by kid, aud
//     `vault.<n>`, iss in the configured hub origins, jti, exp, then the jti not on parachute-revocation.json). We
//     re-implement that check with WebCrypto rather than linking jose or Prism;
//   - REST: apps/server/src/parachute.ts (camelCase notes, `if_updated_at`, `if_exists`, `{versions,total}`);
//   - MCP: the allowlists Prism hands its agents, apps/server/src/agent-profiles.ts:34-51, and the admin-only tools
//     that must stay hidden from a write token (scripts/parachute-compat/lib.mjs:19).
// Green on today's code (stock 0.7.19 hub + 0.7.9 vault). Every lane keeps it green; nothing turns it red on purpose.
// One difference from Benjamin's suite: he calls the vault on its own port (Prism's PARACHUTE_URL defaults to :1940,
// config.ts:31). Inside the box that is 1940, which the guard refuses, so these go through the hub's /vault/<n> route.
import { beforeAll, describe, expect, test } from "bun:test";
import { hubCli } from "../../harness/services.ts";
import { enc, mcp, rest, runId, safeFetch, services } from "../lib.ts";

const s = services();
const R = runId("prism");
const AUD = `vault.${s.vaultName}`;

// Copied from Prism, apps/server/src/agent-profiles.ts:34-51 (snapshot 55ac3df). If Prism changes them, change them here.
const PRISM_VAULT_RO = ["query-notes", "list-tags", "find-path", "vault-info", "doctor"];
const PRISM_VAULT_RW = [
  "query-notes", "create-note", "update-note", "delete-note", "list-tags", "find-path", "vault-info", "doctor",
  "read-attachment", "request-attachment-download",
];
// prism scripts/parachute-compat/lib.mjs:19, and the comment at agent-profiles.ts:35-37.
const ADMIN_ONLY_TOOLS = ["update-tag", "delete-tag", "rename-tag", "merge-tags", "prune-schema", "manage-token"];

const b64json = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
const claimsOf = (jwt: string) => b64json(jwt.split(".")[1]!);
const headerOf = (jwt: string) => b64json(jwt.split(".")[0]!);

/** Mint as Prism does: stock text output, the JWT on the last line (parachute-cli.ts:373-376). */
async function prismMint(args: string[]): Promise<string> {
  const out = await hubCli(s, ["auth", "mint-token", ...args]);
  const last = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? "";
  if (last.split(".").length !== 3) throw new Error("mint-token did not print a JWT on its last line");
  return last;
}

/** Prism's hub-jwt.ts check, re-done with WebCrypto. Returns the reason it would refuse, or null if it accepts. */
async function prismWouldRefuse(token: string, expectedAudience: string): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return "shape";
  const header = headerOf(token);
  if (header.alg !== "RS256") return "signature: alg";
  const jwks = await (await safeFetch(`${s.hub}/.well-known/jwks.json`)).json();
  const jwk = (jwks.keys ?? []).find((k: any) => k.kid === header.kid);
  if (!jwk) return "signature: no key with that kid";
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, Buffer.from(parts[2]!, "base64url"), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return "signature";
  const c = claimsOf(token);
  for (const k of ["iss", "jti", "exp"]) if (c[k] === undefined) return `shape: no ${k}`;
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(expectedAudience)) return "audience";
  if (c.exp <= Math.floor(Date.now() / 1000)) return "expired";
  if (String(c.iss).replace(/\/+$/, "") !== s.hub) return "issuer";
  const rl = await safeFetch(`${s.hub}/.well-known/parachute-revocation.json`);
  if (!rl.ok) return "unavailable";
  const jtis = (await rl.json()).jtis;
  if (!Array.isArray(jtis)) return "unavailable: no jtis";
  if (jtis.includes(c.jti)) return "revoked";
  if (c.vault_scope !== undefined && !(Array.isArray(c.vault_scope) && c.vault_scope.every((v: unknown) => typeof v === "string"))) return "shape: vault_scope";
  return null;
}

const tokens: Record<"read" | "write" | "admin", string> = { read: "", write: "", admin: "" };

beforeAll(async () => {
  // The three mints Benjamin's suite makes (run.mjs:421), which are the ones Prism's server makes.
  tokens.write = await prismMint(["--scope", `vault:${s.vaultName}:write`, "--expires-in", "3600"]);
  tokens.read = await prismMint(["--scope", `vault:${s.vaultName}:read`, "--expires-in", "3600", "--service", "agent-session:compat"]);
  tokens.admin = await prismMint(["--scope", `vault:${s.vaultName}:admin`, "--ephemeral"]);
});

describe("compat/prism: tokens", () => {
  test("minted passes carry iss = the hub, aud vault.<n>, the scope asked for, a jti, and the lifetime asked for", () => {
    for (const verb of ["read", "write", "admin"] as const) {
      const c = claimsOf(tokens[verb]);
      expect(c.iss).toBe(s.hub);
      expect(Array.isArray(c.aud) ? c.aud : [c.aud]).toContain(AUD);
      expect(String(c.scope).split(/\s+/)).toContain(`vault:${s.vaultName}:${verb}`);
      expect(c.jti).toBeString();
      expect(c.jti.length).toBeGreaterThan(0);
      expect(c.exp - c.iat).toBe(3600); // --expires-in 3600, and --ephemeral is 1 h (mcp-token.ts:24-27)
    }
  });

  test("--service <id> makes the pass's sub that id, not the operator (mcp-token.ts:14-18, hub#872)", () => {
    expect(claimsOf(tokens.read).sub).toBe("agent-session:compat");
    expect(claimsOf(tokens.write).sub).not.toBe("agent-session:compat");
  });

  test("the JWKS has the signing key, and Prism's verifier accepts every minted pass", async () => {
    const jwks = await (await safeFetch(`${s.hub}/.well-known/jwks.json`)).json();
    for (const verb of ["read", "write", "admin"] as const) {
      expect(jwks.keys.map((k: any) => k.kid)).toContain(headerOf(tokens[verb]).kid);
      expect(await prismWouldRefuse(tokens[verb], AUD)).toBeNull();
    }
  });

  test("Prism's verifier refuses a pass for another vault, and a pass with a forged signature", async () => {
    expect(await prismWouldRefuse(tokens.write, "vault.someone-else")).toBe("audience");
    const [h, p] = tokens.write.split(".");
    const forged = `${h}.${p}.${Buffer.from("not the hub's signature").toString("base64url")}`;
    expect(await prismWouldRefuse(forged, AUD)).toBe("signature");
  });
});

describe("compat/prism: REST", () => {
  let api: ReturnType<typeof rest>;
  let id = "";
  let stamp = "";
  beforeAll(() => {
    api = rest(s.vaultViaHub, tokens.write);
  });

  test("no token → 401", async () => {
    const r = await safeFetch(`${s.vaultViaHub}/api/notes?limit=1`);
    expect(r.status).toBe(401);
  });

  test("POST /notes, then GET /notes/:id gives the note back in camelCase with updatedAt", async () => {
    const created = await api.post("/notes", { content: "compat note", path: `${R}/one`, tags: [`${R}-tag`] });
    expect(created.status).toBe(201);
    id = created.body.id;
    expect(id).toBeString();
    const got = await api.get(`/notes/${enc(id)}`);
    expect(got.status).toBe(200);
    expect(got.body.content).toBe("compat note");
    expect(got.body.path).toBe(`${R}/one`);
    expect(got.body.tags).toEqual([`${R}-tag`]);
    expect(got.body.createdAt).toBeString();
    expect(got.body.updatedAt).toBeString();
    stamp = got.body.updatedAt;
  });

  test("PATCH with the current if_updated_at → 200; the same stale stamp again → 409", async () => {
    const ok = await api.patch(`/notes/${enc(id)}`, { content: "compat note v2", if_updated_at: stamp });
    expect(ok.status).toBe(200);
    const stale = await api.patch(`/notes/${enc(id)}`, { content: "stale", if_updated_at: stamp });
    expect(stale.status).toBe(409);
    expect((await api.get(`/notes/${enc(id)}`)).body.content).toBe("compat note v2");
  });

  test("PATCH with neither if_updated_at nor force → 428 (parachute.ts:86-92)", async () => {
    const r = await api.patch(`/notes/${enc(id)}`, { content: "blind" });
    expect(r.status).toBe(428);
  });

  test("POST to a path that exists, with if_exists:error → 409, and the note is untouched", async () => {
    const dup = await api.post("/notes", { content: "x", path: `${R}/one`, if_exists: "error" });
    expect(dup.status).toBe(409);
    expect((await api.get(`/notes/${enc(id)}`)).body.content).toBe("compat note v2");
  });

  test("GET /notes?tag&include_content=false is a flat array of notes without content", async () => {
    const list = await api.get(`/notes?tag=${enc(`${R}-tag`)}&include_content=false&limit=10`);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    expect(list.body.map((n: any) => n.id)).toEqual([id]);
    expect(list.body[0].content ?? "").toBe("");
  });

  test("GET /notes/:id/versions is {versions, total}, each with version_ix and op (parachute.ts:29-42, 281)", async () => {
    const v = await api.get(`/notes/${enc(id)}/versions`);
    expect(v.status).toBe(200);
    expect(v.body.total).toBeGreaterThanOrEqual(1);
    expect(v.body.versions.length).toBe(v.body.total);
    const row = v.body.versions[0];
    expect(row.note_id).toBe(id);
    expect(row.version_ix).toBeNumber();
    expect(row.op).toBeString();
    const one = await api.get(`/notes/${enc(id)}/versions/${row.version_ix}`);
    expect(one.status).toBe(200);
    expect(one.body.content).toBe("compat note");
  });

  test("a read pass cannot write", async () => {
    const ro = await rest(s.vaultViaHub, tokens.read).patch(`/notes/${enc(id)}`, { content: "ro", force: true });
    expect([401, 403]).toContain(ro.status);
  });

  test("tag schema: PUT /tags/:name with a write pass → 403, with an admin pass → 200", async () => {
    const schema = { description: "compat", fields: { compat_field: { type: "string" } } };
    const tw = await api.put(`/tags/${enc(`${R}-schema`)}`, schema);
    expect(tw.status).toBe(403);
    const ta = await rest(s.vaultViaHub, tokens.admin).put(`/tags/${enc(`${R}-schema`)}`, schema);
    expect(ta.status).toBe(200);
  });

  test("DELETE /notes/:id → 2xx and the note is gone", async () => {
    const del = await api.del(`/notes/${enc(id)}`);
    expect(del.status).toBeLessThan(300);
    expect((await api.get(`/notes/${enc(id)}`)).status).toBe(404);
  });
});

describe("compat/prism: MCP tools per scope", () => {
  async function toolsFor(verb: "read" | "write" | "admin") {
    const c = await mcp(`${s.vaultViaHub}/mcp`, tokens[verb]);
    try {
      return await c.tools();
    } finally {
      await c.close();
    }
  }

  // Prism calls vault-ro "the tools whose requiredVerb is read" (agent-profiles.ts:32-33), but a read pass also sees
  // read-attachment and request-attachment-download today. Prism hands its agents an explicit allowlist, so what it
  // relies on is that every allowlisted tool is there, and that nothing which writes is.
  test("a read pass sees every tool in Prism's vault-ro allowlist, and no write or admin tool", async () => {
    const names = await toolsFor("read");
    expect(PRISM_VAULT_RO.filter((t) => !names.includes(t))).toEqual([]);
    const writers = ["create-note", "update-note", "delete-note", "request-attachment-upload", ...ADMIN_ONLY_TOOLS];
    expect(writers.filter((t) => names.includes(t))).toEqual([]);
  });

  test("a write pass sees every tool in Prism's vault-rw allowlist and none of the admin-only tools", async () => {
    const names = await toolsFor("write");
    expect(PRISM_VAULT_RW.filter((t) => !names.includes(t))).toEqual([]);
    expect(ADMIN_ONLY_TOOLS.filter((t) => names.includes(t))).toEqual([]);
  });

  test("an admin pass sees the vault-rw allowlist and the admin-only tools", async () => {
    const names = await toolsFor("admin");
    expect(PRISM_VAULT_RW.filter((t) => !names.includes(t))).toEqual([]);
    expect(ADMIN_ONLY_TOOLS.filter((t) => !names.includes(t))).toEqual([]);
  });
});

describe("compat/prism: revocation", () => {
  test("auth revoke-token <jti> puts the jti on the public revocation list, and Prism's verifier then refuses it", async () => {
    // A pass of its own, so the other tests' read pass stays valid whatever order they run in.
    const tok = await prismMint(["--scope", `vault:${s.vaultName}:read`, "--expires-in", "3600", "--service", "agent-session:revoke"]);
    const jti = claimsOf(tok).jti;
    expect(await prismWouldRefuse(tok, AUD)).toBeNull();
    await hubCli(s, ["auth", "revoke-token", jti]);
    const rl = await safeFetch(`${s.hub}/.well-known/parachute-revocation.json`);
    expect(rl.status).toBe(200);
    expect((await rl.json()).jtis).toContain(jti);
    expect(await prismWouldRefuse(tok, AUD)).toBe("revoked");
  });

  test("the vault refuses a revoked pass within its 60 s convergence window (run.mjs:509-523)", async () => {
    const tok = await prismMint(["--scope", `vault:${s.vaultName}:read`, "--expires-in", "3600", "--service", "agent-session:revoke2"]);
    const api = rest(s.vaultViaHub, tok);
    expect((await api.get("/notes?limit=1")).status).toBe(200);
    await hubCli(s, ["auth", "revoke-token", claimsOf(tok).jti]);
    const t0 = Date.now();
    let status = 200;
    while (Date.now() - t0 < 75_000) {
      status = (await api.get("/notes?limit=1")).status;
      if (status === 401 || status === 403) break;
      await Bun.sleep(1000);
    }
    expect([401, 403]).toContain(status);
  }, 100_000);
});
