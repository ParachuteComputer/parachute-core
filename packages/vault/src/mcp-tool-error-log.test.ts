/**
 * An MCP tool that crashes leaves one line in the server log (audit L6-02).
 *
 * Before this, `tools/call query-notes {"tag":123}` returned `Error: tag.replace is not a function…` to the client
 * while the server's whole log for the call was `POST /vault/<name>/mcp 200`. This drives real `tools/call`s over
 * HTTP against a real server subprocess (`bun src/server.ts`, the first-boot-create.test.ts pattern) in a temp
 * PARACHUTE_HOME, and reads what the server printed. The two crashes are real engine bugs the audit found
 * (`query-notes {tag: 123}`, `create-note {tags: {a: …}}`); when one is fixed it becomes a refusal or a success and
 * its test here goes red: swap in another crash then. The last describe drives `handleMcp` with a tool that throws
 * on purpose, so the line itself stays covered whatever the engine's bugs are.
 *
 * A package test, not a contract: the log line is not door-visible behaviour. A client sees the same `isError`
 * result before and after; contracts talk HTTP and MCP to the door and can't read the server's stderr.
 *
 * Port 19420 is fixed (the server reads PORT); first-boot-create.test.ts uses 19410/19411, stop-signal 19404.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { waitForHealthy } from "./health.ts";
import { mcpToolErrorLine, redactErrorMessage, stackFrames } from "../core/src/mcp-error-log.ts";
import { handleMcp } from "./mcp-http.ts";
import type { AuthResult } from "./auth.ts";
import pkg from "../package.json" with { type: "json" };

const SERVER_PATH = resolve(import.meta.dir, "server.ts");
const PORT = 19_420;
const VAULT = "logtest";
const TOKEN = `made-up-operator-${Math.random().toString(36).slice(2)}`;
/** Passed as tool arguments; must never reach the log. */
const MARKER = `marker-${Math.random().toString(36).slice(2)}`;
/** Each real-server test waits for log lines; above bun's 5 s default so a missing line fails as itself. */
const E2E_TIMEOUT = 15_000;

let home: string;
let proc: ReturnType<typeof Bun.spawn>;
let output = "";
let reading: Promise<void>[] = [];

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
}

async function callTool(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${PORT}/vault/${VAULT}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  return res.json();
}

/**
 * Every crash line printed since `from` (an offset into `output`). The crash line goes to stderr and the request line
 * (`POST … 200`) to stdout, read by two loops, so neither order is guaranteed: wait for the request line (it must
 * come, or the check would pass on nothing), then for `expected` crash lines, then a moment more for any extra one.
 */
async function crashLinesSince(from: number, expected: number): Promise<string[]> {
  const crashes = () => output.slice(from).split("\n").filter((l) => l.includes("event=mcp_tool_error"));
  const deadline = Date.now() + 5_000;
  while (!output.slice(from).includes(`POST /vault/${VAULT}/mcp`)) {
    if (Date.now() > deadline) throw new Error("the server never logged the request");
    await Bun.sleep(20);
  }
  const crashDeadline = Date.now() + 1_500;
  while (crashes().length < expected && Date.now() < crashDeadline) await Bun.sleep(20);
  await Bun.sleep(200);
  return crashes();
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "vault-mcp-tool-error-log-"));
  mkdirSync(join(home, "vault"), { recursive: true });
  proc = Bun.spawn({
    cmd: ["bun", SERVER_PATH],
    env: {
      ...process.env,
      PARACHUTE_HOME: home,
      PORT: String(PORT),
      PARACHUTE_VAULT_NAME: VAULT,
      VAULT_AUTH_TOKEN: TOKEN,
      SCRIBE_URL: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  reading = [drain(proc.stdout as ReadableStream<Uint8Array>), drain(proc.stderr as ReadableStream<Uint8Array>)];
  const health = await waitForHealthy(PORT, { totalMs: 15_000 });
  if (health.status !== "healthy") {
    proc.kill();
    throw new Error(`server failed to become healthy: ${health.status} (${health.error ?? ""})`);
  }
}, 20_000); // the server can take longer than bun's 5 s hook default to boot on a loaded machine

afterAll(async () => {
  if (proc && !proc.killed) proc.kill();
  await proc?.exited;
  await Promise.allSettled(reading);
  rmSync(home, { recursive: true, force: true });
});

describe("MCP tool crash → one server log line (audit L6-02)", () => {
  test("a TypeError inside a tool logs exactly one line with the tool, class, frames and version", async () => {
    const from = output.length;
    const body = await callTool("query-notes", { tag: 123, search: MARKER });
    // What the client sees is unchanged: the in-band isError text.
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("is not a function");

    const lines = await crashLinesSince(from, 1);
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line).toContain("tool=query-notes");
    expect(line).toContain("class=TypeError");
    expect(line).toContain(`version=${pkg.version}`);
    expect(line).toMatch(/stack="at [^"]+"/);
    // JSC quotes the failing source text (`(In 'tag.replace(…)', …)`); none of it survives.
    expect(line).toMatch(/msg="[^"']*is not a function[^"']*"/);
  }, E2E_TIMEOUT);

  test("a crash in a write tool logs one line, and the argument values never reach the log", async () => {
    const from = output.length;
    const body = await callTool("create-note", { content: MARKER, path: `p/${MARKER}`, tags: { a: MARKER } });
    expect(body.result?.isError).toBe(true);
    const lines = await crashLinesSince(from, 1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("tool=create-note");
    expect(lines[0]).toContain("class=TypeError");
    expect(output).not.toContain(MARKER);
  }, E2E_TIMEOUT);

  test("a domain refusal (error_type) logs no crash line", async () => {
    const from = output.length;
    const body = await callTool("update-note", { id: MARKER, content: "x" });
    expect(body.error?.data?.error_type).toBe("not_found");
    expect(await crashLinesSince(from, 0)).toEqual([]);
    expect(output).not.toContain(MARKER);
  }, E2E_TIMEOUT);
});

describe("mcpToolErrorLine — what the line may carry", () => {
  test("quoted spans in the message are cut, so quoted input (V8's JSON.parse) stays out", () => {
    // Bun's JSON.parse doesn't quote its input; V8's (cloud) does, and the input carries its own quotes. These are
    // V8's real messages for JSON.parse('[10,"<marker>",x]') and JSON.parse('{"a":[1,"<marker>",x]}').
    for (const input of [`[10,"${MARKER}",x]`, `{"a":[1,"${MARKER}",x]}`, `{"pw": ${MARKER}}`]) {
      const err = new SyntaxError(`Unexpected token 'x', "${input}" is not valid JSON`);
      const line = mcpToolErrorLine("create-note", err, "1.2.3");
      expect(line).toContain('class=SyntaxError msg="Unexpected token … is not valid JSON"');
      expect(line).not.toContain(MARKER);
    }
    expect(redactErrorMessage(`bad \`${MARKER}\` here`)).toBe("bad … here");
    expect(redactErrorMessage(`name: ‘${MARKER}’ “${MARKER}” «${MARKER}»`)).toBe("name: …");
  });

  test("quotes are not paired: first quote to last is cut, a lone quote takes the rest", () => {
    expect(redactErrorMessage(`Unexpected end of input "${MARKER}`)).toBe("Unexpected end of input …");
    expect(redactErrorMessage("Can't find variable: foo")).toBe("Can…");
    expect(redactErrorMessage(`Note '${MARKER}'s diary ${MARKER}' not found`)).toBe("Note … not found");
    expect(redactErrorMessage(`bad "a\\"${MARKER}" here`)).toBe("bad … here");
    expect(redactErrorMessage(`open '/nope/${MARKER}' x.md'`)).toBe("open …");
    // JSC's source excerpt, as the real server prints it.
    expect(redactErrorMessage(`tag.replace is not a function. (In 'tag.replace(/^[#\\s]+/, "")', 'tag.replace' is undefined)`)).toBe(
      "tag.replace is not a function. (In … is undefined)",
    );
  });

  test("newlines collapse and the message stops at 200 chars, never inside a surrogate pair", () => {
    expect(redactErrorMessage("a\n  b\r\nc")).toBe("a b c");
    expect(redactErrorMessage("x".repeat(500))).toHaveLength(200);
    expect(redactErrorMessage(`${"x".repeat(199)}😀`)).toBe("x".repeat(199));
  });

  test("a backslash at the end of the message can't escape the closing quote", () => {
    const line = mcpToolErrorLine("t", new Error("path C:\\dir\\"), "1");
    expect(line).toContain('msg="path C:\\\\dir\\\\" stack="');
    // An unclosed quote that runs into a trailing backslash is still cut, and leaves no raw quote behind.
    expect(mcpToolErrorLine("t", new Error(`Path "C:\\${MARKER}\\`), "1")).toContain('msg="Path …" stack="');
  });

  test("the stack keeps only `at` frames (at most 10), never the message lines above them", () => {
    const message = `first line\nat ${MARKER}`;
    const frames = Array.from({ length: 12 }, (_, i) => `    at f${i} (/x/core/src/notes.ts:${i}:1)`);
    const stack = `TypeError: ${message}\n${frames.join("\n")}`;
    const out = stackFrames(stack, message);
    expect(out).not.toContain(MARKER);
    expect(out.split(" | ")).toHaveLength(10);
    expect(out.startsWith("at f0 (/x/core/src/notes.ts:0:1)")).toBe(true);
    // The message was changed after the stack was taken, so it can't be found in the stack: a message line that
    // starts with "at " still isn't a frame, because a frame ends in its location.
    expect(stackFrames(stack, `ctx: ${message}`)).toBe(out);
    // JSC's other location forms are frames too.
    expect(stackFrames("E: m\n    at a (unknown)\n    at b (native:12)\n    at c (native)", "m")).toBe(
      "at a (unknown) | at b (native:12) | at c (native)",
    );
  });

  test("a stack getter that throws loses only the stack", () => {
    const err = new TypeError("x is not a function");
    Object.defineProperty(err, "stack", { get: () => { throw new Error("no stack"); } });
    expect(mcpToolErrorLine("t", err, "1")).toBe(
      'event=mcp_tool_error tool=t class=TypeError msg="x is not a function" stack="" version=1',
    );
  });

  test("a thrown value whose getters throw still gives a line, and the log call doesn't throw", () => {
    const hostile = new Proxy({}, { get() { throw new Error("getter"); } });
    expect(mcpToolErrorLine("t", hostile, "1")).toBe('event=mcp_tool_error tool=t class=unknown msg="" stack="" version=1');
  });

  test("a thrown non-Error still gives a well-formed line", () => {
    expect(mcpToolErrorLine("t", MARKER, "1")).toBe('event=mcp_tool_error tool=t class=string msg="" stack="" version=1');
    expect(mcpToolErrorLine("t", null, "1")).toContain("class=null");
  });
});

describe("handleMcp — a tool that throws on purpose", () => {
  const auth: AuthResult = {
    permission: "full",
    scopes: ["vault:v:read", "vault:v:write", "vault:v:admin"],
    legacyDerived: false,
    scoped_tags: null,
    vault_name: null,
    caller_jti: null,
    actor: "test-user",
    via: "api",
  };

  async function callThrowing(err: unknown): Promise<{ body: any; logged: string[] }> {
    const logged: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    try {
      const tools = () => [
        {
          name: "boom",
          description: "throws",
          inputSchema: { type: "object", properties: {} },
          requiredVerb: "read" as const,
          execute: () => {
            throw err;
          },
        },
      ];
      const req = new Request("http://localhost/vault/v/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "boom", arguments: { content: MARKER } },
        }),
      });
      const res = await handleMcp(req, tools, "test", "v", auth, "");
      return { body: await res.json(), logged };
    } finally {
      console.error = original;
    }
  }

  test("a TypeError logs one line; the client's isError text is unchanged", async () => {
    const { body, logged } = await callThrowing(new TypeError("x.y is not a function"));
    expect(body.result).toEqual({ content: [{ type: "text", text: "Error: x.y is not a function" }], isError: true });
    const crashes = logged.filter((l) => l.includes("event=mcp_tool_error"));
    expect(crashes).toHaveLength(1);
    expect(crashes[0]).toStartWith('event=mcp_tool_error tool=boom class=TypeError msg="x.y is not a function" stack="at ');
    expect(logged.join("\n")).not.toContain(MARKER);
  });

  test("an error carrying error_type is a refusal: no line", async () => {
    const refusal = Object.assign(new Error("nope"), { error_type: "not_found" });
    const { body, logged } = await callThrowing(refusal);
    expect(body.error?.data?.error_type).toBe("not_found");
    expect(logged.filter((l) => l.includes("event=mcp_tool_error"))).toEqual([]);
  });
});
