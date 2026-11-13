/**
 * The 0.9 tool surface, built from the engine's tools (T-318 §4, T-407): the
 * record tools, the eleven tools, the old note tools as working aliases, the
 * tools/list order, `vault-info {help}` and vault-info in record words, and
 * unknown-parameter teaching. One copy for every door (T-456 cloud parity,
 * audit L1-01): a box builds it in packages/vault/src/mcp-tools.ts and the
 * cloud door in parachute-cloud's vault worker, both through
 * {@link shapeRecordSurface}, so an agent sees the same tools/list, the same
 * words and the same refusals on each.
 *
 * What stays with the door is passed in, never imported: whether the caller
 * holds a verb on this vault, where a name's use is counted, where an unknown
 * parameter is counted, which tag names a tag-scoped caller can see, and any
 * tool the door adds itself (a box's `manage-token`).
 *
 * Build it after every scope guard and wrapper is on the engine's tools, so a
 * new name can never do more than the old one did.
 */
import type { Database } from "bun:sqlite";
import type { McpToolDef } from "./mcp.js";
import { MCP_TOOL_REFERENCE, acceptedParams } from "./mcp-manifest.js";
import { addRecordTools, NOTE_TOOL_NAMES, RECORD_TOOL_NAMES, recordParamNames, recordSchema, recordWords } from "./mcp-records.js";
import {
  FOLD_ONLY,
  NEW_TOOLS,
  REFUSES_UNKNOWN_PARAMS,
  SHORT_TOOLS,
  TOOL_ALIASES,
  TOOL_ORDER,
  aliasDescription,
  nestedParamProblem,
  unknownParams,
  type ParamProblem,
} from "./mcp-short.js";
import { refuseTypesInTags } from "./tag-kind.js";
import { capVaultInfoTags } from "./vault-projection.js";

export type Verb = "read" | "write" | "admin";

/** A tool a door adds that the engine has no reference for (a box's `manage-token`): what `help` and the parameter
 *  check read for it. */
export interface DoorToolReference {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RecordSurfaceOpts {
  /** The vault's database: the record door's type-in-tags check reads it. */
  db: Database;
  vaultName: string;
  /** Does this caller hold `verb` on this vault? Omitted: the caller's scopes were settled outside (a box's local
   *  stdio), so nothing is narrowed. */
  hasVerb?: (verb: Verb) => boolean;
  /** Count one use of a name: a tool (`create-record`), or a tool and parameter (`attachment-url note`). `old`: a
   *  name 1.0 removes; `new`: its replacement. Names only, never a value. */
  onUse?: (name: string, kind: "old" | "new") => void;
  /** Count one unknown parameter, by tool and parameter name (caller-chosen text: the door bounds it). */
  onUnknownParam?: (tool: string, field: string, refused: boolean) => void;
  /** A tag-scoped caller's view: does it see this tag name? Omitted: every name. */
  tagVisible?: () => Promise<(name: string) => boolean>;
  /** References for tools the door adds itself (`manage-token`, `manage-keys`). */
  doorTool?: (name: string) => DoorToolReference | undefined;
}

const VERB_RANK: Record<Verb, number> = { read: 0, write: 1, admin: 2 };

/**
 * The engine's tools (vault-info already given its door's projection) → the 0.9 surface, in tools/list order. Each
 * door then filters the list by the caller's verb, as before.
 */
export function shapeRecordSurface(tools: McpToolDef[], opts: RecordSurfaceOpts): McpToolDef[] {
  capVaultInfo(tools);
  // The record door's `tags` hold plain labels (SPEC §2.4): a type's name there is refused with the fix. A name a
  // tag-scoped session can't see is left to the scope check, so its kind isn't told.
  const recordCheck = async (tool: string, call: Record<string, unknown>) => {
    if (tool !== "create-record" && tool !== "update-record") return;
    const visible = opts.tagVisible ? await opts.tagVisible() : undefined;
    refuseTypesInTags(opts.db, call, tool === "create-record" ? "create" : "update", visible);
  };
  const shaped = byToolOrder(addRecordTools(applyElevenTools(tools, opts), opts.onUse, recordCheck));
  applyVaultInfoHelp(shaped, opts);
  applyParamTeaching(shaped, opts);
  return shaped;
}

/** vault-info's tag map capped (0.9.2), on the answer the door's own wrappers already narrowed to what the caller sees. */
function capVaultInfo(tools: McpToolDef[]): void {
  const info = tools.find((t) => t.name === "vault-info");
  if (!info) return;
  const execute = info.execute;
  info.execute = async (params) => {
    const r = await execute(params);
    return params?.help === undefined && r && typeof r === "object" && !Array.isArray(r) ? capVaultInfoTags(r as Record<string, unknown>) : r;
  };
}

/**
 * `vault-info {help}` for a tool: its full reference (the long text and every parameter), which the short tools/list
 * descriptions point to. The new tools answer with each action's own reference. `toolNames` is what the refusal of
 * an unknown name lists.
 */
export function toolHelp(name: string, toolNames: readonly string[], doorTool?: (name: string) => DoorToolReference | undefined): Record<string, unknown> {
  const spec = NEW_TOOLS[name];
  if (spec) {
    return {
      tool: name,
      description: spec.description,
      parameters: spec.inputSchema,
      // Each action takes the parameters of the tool it replaces.
      actions: Object.fromEntries(
        Object.entries(spec.folds).map(([action, old]) => [action, { replaces: old, parameters: MCP_TOOL_REFERENCE.find((e) => e.name === old)?.inputSchema }]),
      ),
    };
  }
  const ref = doorTool?.(name) ?? MCP_TOOL_REFERENCE.find((e) => e.name === name);
  if (!ref) {
    throw Object.assign(new Error(`No tool named "${name}". Tools: ${toolNames.join(", ")}.`), {
      error_type: "unknown_tool",
      field: "help",
      hint: "pass one of the tool names",
    });
  }
  return { tool: ref.name, description: ref.description, parameters: ref.inputSchema };
}

/**
 * manage-types and attachment-url, built from the tools they fold (each action re-checks its own verb); find-path
 * folded into query-notes as `path_between`; `manage-token` relisted as `manage-keys`; the nine old names kept with
 * a one-line deprecation description and a `deprecation` field on their object results. Gone in 1.0.
 */
function applyElevenTools(tools: McpToolDef[], opts: RecordSurfaceOpts): McpToolDef[] {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const out: McpToolDef[] = [];

  for (const [name, spec] of Object.entries(NEW_TOOLS)) {
    const folded = Object.values(spec.folds).map((n) => byName.get(n));
    if (folded.some((t) => !t)) continue; // e.g. no attachment tickets wired: no attachment-url
    const actions = Object.keys(spec.folds);
    out.push({
      name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      // The least any action needs; each action re-checks its own verb below.
      requiredVerb: folded.map((t) => (t!.requiredVerb ?? "write") as Verb).sort((a, b) => VERB_RANK[a] - VERB_RANK[b])[0]!,
      execute: async (params) => {
        const action = (params.action ?? (name === "manage-types" ? "update" : undefined)) as string | undefined;
        const target = action ? byName.get(spec.folds[action] ?? "") : undefined;
        if (!target) {
          throw Object.assign(new Error(`${name} needs \`action\`: ${actions.join(", ")}.`), {
            error_type: "unknown_parameter",
            field: "action",
            hint: `one of ${actions.join(", ")}`,
          });
        }
        const verb = (target.requiredVerb ?? "write") as Verb;
        if (opts.hasVerb && !opts.hasVerb(verb)) {
          throw new Error(`Forbidden: ${name} {action: "${action}"} needs the 'vault:${opts.vaultName}:${verb}' scope.`);
        }
        const { action: _drop, ...rest } = params;
        // T-407: attachment-url names the record it uploads to `record`; `note` stays as its old name through 0.9.
        if (name === "attachment-url" && rest.record !== undefined) {
          if (rest.note !== undefined) {
            throw Object.assign(new Error("attachment-url: pass `record` or `note`, not both (`note` is its old name)."), {
              error_type: "invalid_query",
              field: "record",
              hint: "use record",
            });
          }
          const { record, ...others } = rest;
          return target.execute({ ...others, note: record });
        }
        if (name === "attachment-url" && rest.note !== undefined) opts.onUse?.("attachment-url note", "old");
        return target.execute(rest);
      },
    });
  }

  const token = byName.get("manage-token");
  if (token) {
    out.push({ ...token, name: "manage-keys", description: token.description.replace('vault-info {help: "manage-token"}', 'vault-info {help: "manage-keys"}') });
  }

  const query = byName.get("query-notes");
  const findPath = byName.get("find-path");
  if (query && findPath) {
    const execute = query.execute;
    query.execute = async (params) => {
      if (params.path_between === undefined) return execute(params);
      const pb = params.path_between as Record<string, unknown> | null;
      if (!pb || typeof pb !== "object" || Array.isArray(pb)) {
        throw Object.assign(new Error("path_between takes {source, target, max_depth?}."), { error_type: "invalid_query", field: "path_between" });
      }
      return findPath.execute(pb);
    };
  }

  for (const t of tools) {
    if (FOLD_ONLY.has(t.name)) continue;
    if (!(t.name in TOOL_ALIASES)) {
      out.push(t);
      continue;
    }
    const execute = t.execute;
    const use = TOOL_ALIASES[t.name]!;
    out.push({
      ...t,
      description: aliasDescription(t.name),
      execute: async (params) => {
        opts.onUse?.(t.name, "old");
        const result = await execute(params);
        if (result && typeof result === "object" && !Array.isArray(result)) {
          return { ...(result as Record<string, unknown>), deprecation: { tool: t.name, use, removed_in: "1.0" } };
        }
        return result;
      },
    });
  }

  return byToolOrder(out);
}

/** tools/list's order: TOOL_ORDER, then anything it doesn't name. */
export function byToolOrder<T extends { name: string }>(tools: T[]): T[] {
  const rank = (n: string) => {
    const i = TOOL_ORDER.indexOf(n);
    return i === -1 ? TOOL_ORDER.length : i;
  };
  return tools.sort((a, b) => rank(a.name) - rank(b.name));
}

/**
 * vault-info's `help` (any listed tool's full reference), and vault-info on the record surface (T-407): `help` for a
 * record tool answers with its note tool's full reference in record words, and the query hints name the record
 * tools. Everything else vault-info returns keeps its shape.
 */
function applyVaultInfoHelp(tools: McpToolDef[], opts: RecordSurfaceOpts): void {
  const info = tools.find((t) => t.name === "vault-info");
  if (!info) return;
  const execute = info.execute;
  const names = tools.map((t) => t.name);
  const reference = (name: string) => toolHelp(name, names, opts.doorTool);
  info.execute = async (params) => {
    const help = params?.help;
    if (help !== undefined) {
      if (params.description !== undefined && params.description !== null) {
        throw Object.assign(new Error("vault-info: pass help or description, not both."), { error_type: "invalid_query", field: "help", hint: "two calls" });
      }
      const name = String(help);
      const noteTool = NOTE_TOOL_NAMES[name];
      if (noteTool) {
        const r = reference(noteTool) as { description?: string; parameters?: Record<string, unknown> };
        return { tool: name, description: recordWords(r.description ?? ""), parameters: recordSchema(noteTool, r.parameters ?? {}) };
      }
      const r = reference(name);
      if (RECORD_TOOL_NAMES[name]) return { ...r, deprecation: { tool: name, use: RECORD_TOOL_NAMES[name], removed_in: "1.0" } };
      return r;
    }
    const r = await execute(params);
    if (r && typeof r === "object" && Array.isArray((r as { query_hints?: unknown }).query_hints)) {
      const o = r as { query_hints: unknown[] };
      return { ...o, query_hints: o.query_hints.map((h) => (typeof h === "string" ? recordWords(h) : h)) };
    }
    return r;
  };
}

/** Every parameter a core tool takes: its full reference schema and the short schema it advertises. */
function takes(name: string): string[] {
  return [...new Set([...(acceptedParams(name) ?? []), ...Object.keys((SHORT_TOOLS[name]?.inputSchema as { properties?: object })?.properties ?? {})])];
}

/**
 * Parameters a tool doesn't know. On the tools 0.9 adds (REFUSES_UNKNOWN_PARAMS: the record tools, manage-types,
 * attachment-url, manage-keys) the call is refused before it runs, with each name's fix (audit L7-12, SPEC v2 §4.3).
 * On every name a 0.8 client can call (T-318 §4, and the 10-30 decision "nothing removed before 1.0") the call runs
 * with them ignored, as on 0.8, so no client that worked on 0.8 breaks. Unlike 0.8 the answer says so:
 *   - an object answer gets a `warnings` entry per name, `{code: "unknown_parameter", message, field, hint}`;
 *   - an array answer keeps its shape, so the door's count is its only trace;
 *   - a call that fails anyway names the fix in its error;
 *   - every name is counted through `onUnknownParam` (tool and parameter name, never the value).
 * `manage-types` and `attachment-url` check against the action called: a parameter only another action takes is
 * refused by this one, with its name. With no valid action (attachment-url has no default) the call is refused with
 * the list of actions. A misused nested key (`near: {id}`) is refused, as 0.8 refused it. A tool accepts every
 * parameter in its full reference schema and in the short schema it advertises.
 */
function applyParamTeaching(tools: McpToolDef[], opts: RecordSurfaceOpts): void {
  for (const tool of tools) {
    const folds = NEW_TOOLS[tool.name]?.folds;
    const noteTool = NOTE_TOOL_NAMES[tool.name];
    const door = opts.doorTool?.(tool.name);
    const reference = noteTool
      ? recordParamNames(tool.name, takes(noteTool))
      : door
        ? Object.keys((door.inputSchema.properties as object | undefined) ?? {})
        : folds
          ? ["action", ...Object.values(folds).flatMap(takes), ...(tool.name === "attachment-url" ? ["record"] : [])]
          : RECORD_TOOL_NAMES[tool.name]
            ? takes(tool.name) // a relisted note tool: its old short schema too
            : acceptedParams(tool.name);
    if (!reference) continue;
    const accepted = [...new Set([...reference, ...Object.keys((tool.inputSchema as { properties?: object }).properties ?? {})])];
    const perAction = folds
      ? Object.fromEntries(Object.entries(folds).map(([a, n]) => [a, ["action", ...takes(n), ...(n === "request-attachment-upload" ? ["record"] : [])]]))
      : undefined;
    const acceptedFor = (params: Record<string, unknown>) => {
      const action = params.action ?? (tool.name === "manage-types" ? "update" : undefined);
      return (typeof action === "string" && perAction?.[action]) || accepted;
    };
    const execute = tool.execute;
    tool.execute = async (params) => {
      const nested = nestedParamProblem(tool.name, params ?? {});
      if (nested) throw Object.assign(new Error(nested.message), nested);
      const refuses = REFUSES_UNKNOWN_PARAMS.has(tool.name);
      const unknown = unknownParams(tool.name, params ?? {}, acceptedFor(params ?? {}), refuses);
      if (unknown.length === 0) return execute(params);
      for (const u of unknown) opts.onUnknownParam?.(tool.name, u.field, refuses);
      if (refuses) {
        // Before anything runs, so nothing is written: every unknown name in one message, the first one's fix.
        const [first] = unknown;
        const message =
          unknown.length === 1
            ? first!.message
            : `${unknown.map((u) => u.message.replace(/ Every parameter:.*$/, "")).join(" ")} Every parameter: vault-info {help: "${tool.name}"}.`;
        throw Object.assign(new Error(message), { error_type: "unknown_parameter", field: first!.field, hint: first!.hint });
      }
      let result: unknown;
      try {
        result = await execute(params);
      } catch (err) {
        try {
          if (err instanceof Error) err.message += ` (Also: ${unknown.map((u) => u.message.replace(/ Every parameter:.*$/, "")).join(" ")})`;
        } catch {} // a frozen error keeps its own message
        throw err;
      }
      return withParamWarnings(tool.name, result, unknown);
    };
  }
}

function withParamWarnings(tool: string, result: unknown, unknown: ParamProblem[]): unknown {
  const warnings = unknown.map((u) => ({ code: u.error_type, message: u.message, field: u.field, hint: u.hint }));
  // query-notes answers `{notes, warnings}` whenever it has a warning (core mcp.ts), a shape its callers already read.
  if (tool === "query-notes" && Array.isArray(result)) return { notes: result, warnings };
  if (tool === "query-records" && Array.isArray(result)) return { records: result, warnings };
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const r = result as Record<string, unknown>;
  return { ...r, warnings: [...(Array.isArray(r.warnings) ? r.warnings : []), ...warnings] };
}

/**
 * A refusal's JSON-RPC message names its kind, `[error_type] message` (vault#555), so a person reading only the text
 * knows which kind of refusal it is; the kind is also `data.error_type`, which an app reads.
 */
export function typedMessage(message: string, data: Record<string, unknown> | undefined): string {
  const errorType = typeof data?.error_type === "string" ? data.error_type : undefined;
  return errorType ? `[${errorType}] ${message}` : message;
}

/** A record tool's refusal data in record words (T-407): the hint and how_to, and `record_id` for `note_id`. */
export function recordErrorData(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data };
  for (const k of ["hint", "how_to"]) if (typeof out[k] === "string") out[k] = recordWords(out[k] as string);
  if ("note_id" in out) {
    out.record_id = out.note_id;
    delete out.note_id;
  }
  return out;
}
