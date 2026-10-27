// Run by rollback.test.ts in a network of its own (_lib.ts inOwnNetwork), because the stock box puts its vault on
// the fixed port 1940. PLAN §3 "Adopting an existing stock home in place", the embedded/rollback contract:
//   1. stock 0.7 (oldStockDir()) makes a home as Prism's stock mode does: a vault, a box serve, an operator,
//      a write token ("Prism's old token") and a note;
//   2. the candidate opens that same home with `serve --embedded` on the same hub origin: the old token still
//      works, it writes, updates and mints a new token; services.json is left as it was; it stops cleanly;
//   3. stock 0.7 starts again on the same home: it reads and updates what embedded wrote, and both tokens verify.
// The host passes PARACHUTE_HUB_ORIGIN to both (stock works its issuer out from hub.port, which Prism's stock shim
// writes, prism run.mjs:353-368, and its vault needs PARACHUTE_HUB_JWKS_ORIGIN off :1939).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freePort, newHome, safeFetch } from "../candidate-lib.ts";
import { mint, must, report, serveEmbedded, tail } from "./_lib.ts";
import { binaries, run, serveBox } from "./_stock.ts";

const VAULT = "prism";

function api(base: string, token: string) {
  return async (method: string, path: string, body?: unknown) => {
    const r = await safeFetch(`${base}/vault/${VAULT}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, json, text: text.slice(0, 200) };
  };
}

await report(async (input: { stockOnly?: boolean }) => {
  const stock = await binaries(true);
  const home = newHome("rollback");
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const stockEnv = { PORT: String(port), PARACHUTE_HUB_ORIGIN: origin, PARACHUTE_HUB_JWKS_ORIGIN: origin, EMBEDDINGS_ENABLED: "false" };

  // 1. The stock home.
  const made = await run(stock, home, ["create", VAULT, "--no-mirror", "--json"], stockEnv, true);
  must(made.code === 0, `setup: stock parachute-vault create exited ${made.code}: ${tail(made.stderr)}`);
  mkdirSync(join(home, "hub", "run"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "hub", "run", "hub.port"), `${port}\n`, { mode: 0o600 });
  let box = await serveBox(stock, home, VAULT, stockEnv);
  let oldToken: string;
  let a: { id: string; updatedAt: string };
  try {
    const rot = await run(stock, home, ["auth", "rotate-operator"], stockEnv);
    must(rot.code === 0, `setup: stock rotate-operator exited ${rot.code}: ${tail(rot.stderr)}`);
    const m = await run(stock, home, ["auth", "mint-token", "--scope", `vault:${VAULT}:write`, "--expires-in", "3600"], stockEnv);
    must(m.code === 0, `setup: stock mint-token exited ${m.code}: ${tail(m.stderr)}`);
    oldToken = m.stdout.trim().split("\n").pop()!.trim();
    const w = await api(box.hub, oldToken)("POST", "/notes", { content: "written by stock", path: "rollback/a" });
    must(w.status === 201, `setup: stock write failed: HTTP ${w.status} ${w.text}`);
    a = w.json;
  } finally {
    must((await box.stop()) === 0, "setup: the stock box did not stop cleanly");
  }
  const servicesBefore = readFileSync(join(home, "services.json"), "utf8");

  if (input.stockOnly) {
    // The setup check: stock restarts on its own home and Prism's old token still reads the note.
    box = await serveBox(stock, home, VAULT, stockEnv);
    try {
      const ra = await api(box.hub, oldToken)("GET", `/notes/${a.id}`);
      must(ra.status === 200 && ra.json?.content === "written by stock", `setup: stock restart reading its note: HTTP ${ra.status} ${ra.text}`);
    } finally {
      await box.stop();
    }
    return { ok: true };
  }

  // 2. The same home, embedded, on the same hub origin.
  const e = await serveEmbedded(home, { hubPort: port, env: { PARACHUTE_HUB_ORIGIN: origin } });
  let newToken: string;
  let b: { id: string; updatedAt: string };
  try {
    const old = api(e.vault, oldToken);
    const got = await old("GET", `/notes/${a.id}`);
    must(got.status === 200 && got.json?.content === "written by stock", `embedded: the stock note or Prism's old token failed: HTTP ${got.status} ${got.text}`);
    const up = await old("PATCH", `/notes/${a.id}`, { content: "updated by embedded", if_updated_at: got.json.updatedAt });
    must(up.status === 200, `embedded: updating the stock note failed: HTTP ${up.status} ${up.text}`);
    newToken = (await mint(home, `vault:${VAULT}:write`, ["--expires-in", "3600"], { PARACHUTE_HUB_ORIGIN: origin })).token;
    const w = await api(e.vault, newToken)("POST", "/notes", { content: "written by embedded", path: "rollback/b" });
    must(w.status === 201, `embedded: a write with the new token failed: HTTP ${w.status} ${w.text}`);
    b = w.json;
  } finally {
    must((await e.stop()) === 0, `embedded: serve --embedded did not stop cleanly: ${tail(e.log())}`);
  }
  must(readFileSync(join(home, "services.json"), "utf8") === servicesBefore, "embedded rewrote services.json, which the stock hub needs to roll back");

  // 3. Roll back: stock on the same home.
  box = await serveBox(stock, home, VAULT, stockEnv);
  try {
    for (const [name, token] of [["Prism's old token", oldToken], ["the token minted while embedded", newToken]] as const) {
      const call = api(box.hub, token);
      const ra = await call("GET", `/notes/${a.id}`);
      must(ra.status === 200 && ra.json?.content === "updated by embedded", `rollback: ${name} reading the updated note: HTTP ${ra.status} ${ra.text}`);
      const rb = await call("GET", `/notes/${b.id}`);
      must(rb.status === 200 && rb.json?.content === "written by embedded", `rollback: ${name} reading the embedded note: HTTP ${rb.status} ${rb.text}`);
    }
    const rb = await api(box.hub, oldToken)("GET", `/notes/${b.id}`);
    const up = await api(box.hub, newToken)("PATCH", `/notes/${b.id}`, { content: "updated by stock again", if_updated_at: rb.json.updatedAt });
    must(up.status === 200, `rollback: stock updating the embedded note failed: HTTP ${up.status} ${up.text}`);
  } finally {
    await box.stop();
  }
  return { ok: true };
});
