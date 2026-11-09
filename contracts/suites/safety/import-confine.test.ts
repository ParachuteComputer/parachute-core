// Import reads only the repo it was given (T-419, audit L3-02).
//
// `POST <vault>/.parachute/mirror/import` clones a vault export and imports it. A vault admin (not the box owner)
// could make it read the server's own files two ways:
// - the URL: a local path or `file://` cloned another vault's mirror from the same disk (the audit got
//   "ALICE PRIVATE DIARY ENTRY" into vault bob), `ext::` names a command, and a URL starting with `-` became an
//   option to `git clone` (no `--` before it);
// - symlinks in the cloned repo: the containment check used `path.resolve`, which doesn't follow links, so a note,
//   a folder, a sidecar or an attachment that is a link pointing out of the clone pulled a server file into a
//   note body or the vault's assets.
// Now the route takes only https:// and ssh (`ssh://` and `user@host:path`) and answers anything else with 400,
// git gets `--` before the URL, and the importer skips any link whose real path leaves the clone.
//
// An honest https remote, without the network: the box's own git config (`url.<local repo>.insteadOf`, in the
// box's HOME, which only the box owner can write) rewrites one made-up https URL to a throwaway repo here. The
// vault still sees and checks an https URL; git stands in for the git host. Mutants "import-url-unchecked",
// "import-follows-content-links", "import-follows-sidecar-links" and "import-follows-attachment-links" put each
// guard back.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { operator, pass, runId, safeFetch, services, type Reply } from "../lib.ts";

const s = services();
const op = operator();
const R = runId("ic").replace(/-/g, "");
const SECRET = `MADE-UP SERVER SECRET ${R}`;
const BOX_HOME = dirname(s.home); // the vault's HOME on this throwaway box
const WORK = join(BOX_HOME, `import-confine-${R}`);
const OUTSIDE = join(WORK, "server-only"); // the server's own files, outside any clone
const REPO = join(WORK, "repo");
const GITCONFIG = join(BOX_HOME, ".gitconfig");
const REMOTE = `https://git-${R}.invalid/owner/vault.git`; // rewritten by the box's git config to REPO
let admin = "";
let priorGitconfig: string | null = null;

async function importOver(remote_url: string, extra: Record<string, unknown> = {}): Promise<Reply> {
  // An import already running answers 409; wait it out (a red build may still be running a refused URL's job).
  for (let i = 0; ; i++) {
    const r = await safeFetch(`${s.vaultViaHub}/.parachute/mirror/import`, {
      method: "POST",
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      body: JSON.stringify({ remote_url, mode: "merge", credentials: { kind: "none" }, ...extra }),
    });
    const text = await r.text();
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {}
    if (r.status !== 409 || i >= 50) return { status: r.status, body, headers: r.headers };
    await Bun.sleep(200);
  }
}

function git(args: string[], cwd: string): void {
  const p = Bun.spawnSync(["git", "-c", "user.name=contracts", "-c", "user.email=contracts@example.invalid", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0) throw new Error(`setup: git ${args.join(" ")} failed: ${p.stderr.toString()}`);
}

const fm = (lines: string[], body: string) => `---\n${lines.join("\n")}\n---\n${body}\n`;

beforeAll(async () => {
  admin = await pass({ level: "admin" });
  // The server's own files: a note-shaped file, a folder of them, a sidecar, a schema and a "key".
  mkdirSync(join(OUTSIDE, "folder"), { recursive: true });
  writeFileSync(join(OUTSIDE, "secret.md"), fm([`id: ${R}-leakfile`, `path: ${R}/leak`], SECRET));
  writeFileSync(join(OUTSIDE, "folder", "inner.md"), fm([`id: ${R}-leakdir`, `path: ${R}/linked/inner`], SECRET));
  writeFileSync(join(OUTSIDE, "meta.yaml"), `id: ${R}-leakmeta\npath: ${R}/data\nextension: csv\nmetadata:\n  secret: ${SECRET}\n`);
  writeFileSync(join(OUTSIDE, "schema.yaml"), `description: ${SECRET}\n`);
  writeFileSync(join(OUTSIDE, "key.pem"), `${SECRET}\n`);

  // The repo: a real export (a note, an attachment row) plus a link for each of the above.
  const p = join(REPO, ".parachute");
  mkdirSync(join(p, "notes-meta"), { recursive: true });
  mkdirSync(join(p, "schemas"), { recursive: true });
  mkdirSync(join(p, "attachments", `${R}-a1`), { recursive: true });
  mkdirSync(join(REPO, R), { recursive: true });
  writeFileSync(join(p, "vault.yaml"), "export_format_version: 1\nexported_at: 2026-11-08T00:00:00.000Z\n");
  writeFileSync(join(REPO, R, "ok.md"), fm([`id: ${R}-ok`, `path: ${R}/ok`], "a made-up note"));
  writeFileSync(
    join(REPO, R, "att.md"),
    fm([`id: ${R}-att`, `path: ${R}/att`, "attachments:", `  - id: ${R}-a1`, `    path: ${R}/key.pem`, "    mime_type: text/plain"], "has a file"),
  );
  writeFileSync(join(REPO, R, "data.csv"), "a,b\n1,2\n");
  symlinkSync(join(OUTSIDE, "secret.md"), join(REPO, R, "leak.md"));
  symlinkSync(join(OUTSIDE, "folder"), join(REPO, R, "linked"));
  symlinkSync(join(OUTSIDE, "meta.yaml"), join(p, "notes-meta", `${R}-leakmeta.yaml`));
  symlinkSync(join(OUTSIDE, "schema.yaml"), join(p, "schemas", `${R}s.yaml`));
  symlinkSync(join(OUTSIDE, "key.pem"), join(p, "attachments", `${R}-a1`, "key.pem"));
  git(["init", "-q", "-b", "main"], REPO);
  git(["add", "-A"], REPO);
  git(["commit", "-q", "-m", "made-up export"], REPO);

  priorGitconfig = existsSync(GITCONFIG) ? readFileSync(GITCONFIG, "utf8") : null;
  writeFileSync(GITCONFIG, `${priorGitconfig ?? ""}\n[url "file://${REPO}"]\n\tinsteadOf = ${REMOTE}\n`);
});

afterAll(() => {
  if (priorGitconfig === null) rmSync(GITCONFIG, { force: true });
  else writeFileSync(GITCONFIG, priorGitconfig);
  rmSync(WORK, { recursive: true, force: true });
});

describe("a symlink in the cloned repo doesn't reach the server's files", () => {
  let result: Reply;
  beforeAll(async () => {
    result = await importOver(REMOTE, { wait: true });
  });

  test("the import completes and brings its real notes", async () => {
    expect(result.status, JSON.stringify(result.body).slice(0, 600)).toBe(200);
    const ok = await op.get(`/notes/${R}-ok`);
    expect(ok.status).toBe(200);
    expect(ok.body.content).toContain("a made-up note");
  });

  test("a linked note file and a linked folder import nothing", async () => {
    expect((await op.get(`/notes/${R}-leakfile`)).status).toBe(404);
    expect((await op.get(`/notes/${R}-leakdir`)).status).toBe(404);
    expect(JSON.stringify(result.body)).not.toContain(SECRET);
  });

  test("a linked sidecar and a linked schema import nothing", async () => {
    expect((await op.get(`/notes/${R}-leakmeta`)).status).toBe(404);
    const tag = await op.get(`/tags?tag=${R}s`);
    expect(JSON.stringify(tag.body)).not.toContain(SECRET);
  });

  test("a linked attachment isn't copied into the vault's files", async () => {
    const r = await safeFetch(`${s.vaultViaHub}/api/storage/${R}/key.pem`, {
      headers: { authorization: `Bearer ${s.operatorToken}` },
    });
    expect(await r.text()).not.toContain(SECRET);
    expect(r.status).toBe(404);
  });
});

describe("the import URL: https:// and ssh only, 400 for the rest", () => {
  const refused: [string, string][] = [
    ["a local path", REPO],
    ["a relative path", "../repo"],
    ["file://", `file://${REPO}`],
    ["git://", "git://127.0.0.1/owner/vault.git"],
    ["http://", "http://127.0.0.1:9/owner/vault.git"],
    ["ext::", "ext::false"],
    ["an option (-u)", "-ufalse"],
    ["an option (--upload-pack)", "--upload-pack=false"],
    ["an ssh host that is an option", "ssh://-oProxyCommand=false/owner/vault.git"],
    ["a scp-style host that is an option", "git@-oProxyCommand=false:owner/vault.git"],
  ];
  for (const [what, url] of refused) {
    test(`refuses ${what}`, async () => {
      const r = await importOver(url);
      expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(400);
      expect(r.body.field).toBe("remote_url");
    });
  }

  test("still takes https:// and ssh URLs (they fail later, at the clone, not at the door)", async () => {
    for (const url of ["https://127.0.0.1:9/owner/vault.git", "ssh://git@127.0.0.1:9/owner/vault.git", "git@127.0.0.1:owner/vault.git"]) {
      const r = await importOver(url);
      expect(r.status, `${url}: ${JSON.stringify(r.body).slice(0, 300)}`).toBe(202);
    }
  });
});
