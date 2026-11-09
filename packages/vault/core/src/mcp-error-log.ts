/**
 * The server-side log line for an MCP tool call that crashed (audit L6-02).
 *
 * A tool that throws something nobody tagged as a domain refusal (no `error_type`, not an `McpError`) reaches the
 * client as `isError` text, and before this the server log showed only `POST /vault/<name>/mcp 200`. The caller logs
 * exactly one line, built here:
 *
 *   event=mcp_tool_error tool=<name> class=<constructor name> msg="<redacted message>" stack="<frames>" version=<v>
 *
 * The bun vault (`src/mcp-http.ts`) logs it, and the hub's account MCP logs the same shape from its own copy
 * (`packages/hub/src/mcp-error-log.ts`, pinned identical by a hub test). The cloud worker is meant to log the same
 * keys too, so one search finds a crash on any runtime; this file is runtime-free so cloud can import it.
 *
 * Privacy: the line never carries tool arguments, note content, tokens or headers. The message is the only part
 * built from runtime text, so every quoted span in it is cut (engines quote the offending value or source text:
 * JSC quotes the failing expression, V8's JSON.parse quotes its input), and the stack keeps only its `at …` frame
 * lines, never its first line (which repeats the message).
 */

const MAX_MESSAGE_CHARS = 200;
const MAX_FRAMES = 10;

/**
 * Every quoted span becomes `…`. Double quotes and backticks always delimit, and a backslash-escaped one inside a
 * span doesn't close it. Typographic pairs (“…”, ‘…’, «…») delimit too. A single quote opens a span only when it
 * doesn't follow a letter or digit, and closes it only when no letter or digit follows, so an apostrophe
 * (`Can't find variable`, `'Bob's notes'`) is neither; the price is that a quote glued to a word (`key'value'`) isn't
 * cut. A span with no closing quote runs to the end of the message: an unclosed quote is where user text is most
 * likely to follow.
 */
const QUOTED_SPAN = new RegExp(
  [
    '"(?:[^"\\\\]|\\\\[\\s\\S]?)*(?:"|$)',
    "`(?:[^`\\\\]|\\\\[\\s\\S]?)*(?:`|$)",
    "“[^”]*(?:”|$)",
    "‘[^’]*(?:’|$)",
    "«[^»]*(?:»|$)",
    "(?<![\\p{L}\\p{N}])'(?:[^']|'(?=[\\p{L}\\p{N}]))*(?:'|$)",
  ].join("|"),
  "gu",
);

/** `err.message` made safe to log: quoted spans cut, whitespace runs (newlines too) collapsed, at most 200 chars. */
export function redactErrorMessage(message: string): string {
  const oneLine = message.replace(/\s+/g, " ");
  const cut = oneLine.replace(QUOTED_SPAN, "…").trim().slice(0, MAX_MESSAGE_CHARS);
  // Don't leave half of a surrogate pair at the cut.
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * A value for inside `key="…"`: a backslash is doubled, so one at the end can't read as escaping the closing quote,
 * and a stray `"` becomes `'`, so the value can't end early.
 */
function quoted(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "'")}"`;
}

/**
 * A frame line: `at …` ending in a location (`file:12:5`, `(file:12)`, `(native)`, `(<anonymous>)`, `(unknown)`).
 * Requiring the location keeps a message line that happens to start with "at " out, even when the message was
 * changed after the stack was taken and can't be found in it.
 */
const FRAME = /^at .*(?::\d+(?::\d+)?\)?|\((?:native|<anonymous>|unknown)\))$/;

/** Only the `at …` frame lines of a stack (at most 10), joined with ` | `. Never the message line above them. */
export function stackFrames(stack: string | undefined, message?: string): string {
  if (typeof stack !== "string") return "";
  // A message with a newline in it spreads over several stack lines; drop it first so none of it is read as a frame.
  const body = message && stack.includes(message) ? stack.replace(message, "") : stack;
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => FRAME.test(line))
    .slice(0, MAX_FRAMES)
    .map((line) => line.replace(/"/g, "'"))
    .join(" | ");
}

/** The thrown value's class: its constructor's name (`TypeError`), else its `typeof`. */
export function errorClass(err: unknown): string {
  if (err !== null && typeof err === "object") {
    const name = (err as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof name === "string" && name.length > 0) return token(name);
  }
  return err === null ? "null" : typeof err;
}

/** A bare `key=value` value: anything but word characters and `.:/@-` becomes `_`, so it can't break the line. */
function token(value: string): string {
  return value.replace(/[^\w.:/@-]/g, "_") || "_";
}

/** The one line to `console.error` when the MCP tool `tool` threw `err`. Never throws itself. */
export function mcpToolErrorLine(tool: string, err: unknown, version: string): string {
  // A thrown Proxy or an object with throwing getters must not turn the log call into a second crash: each part is
  // read once, on its own, and a part that throws is left empty without losing the others.
  const read = <T>(f: () => T, fallback: T): T => {
    try {
      return f();
    } catch {
      return fallback;
    }
  };
  const field = (key: "message" | "stack"): string | undefined =>
    read(() => {
      const v = (err as Record<string, unknown> | null | undefined)?.[key];
      return typeof v === "string" ? v : undefined;
    }, undefined);
  const message = field("message") ?? "";
  const stack = field("stack");
  const cls = read(() => errorClass(err), "unknown");
  const msg = read(() => redactErrorMessage(message), "");
  const frames = read(() => stackFrames(stack, message), "");
  return [
    "event=mcp_tool_error",
    `tool=${token(tool)}`,
    `class=${cls}`,
    `msg=${quoted(msg)}`,
    `stack=${quoted(frames)}`,
    `version=${token(version)}`,
  ].join(" ");
}
