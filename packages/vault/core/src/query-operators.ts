/**
 * Metadata operator objects for `query-notes`.
 *
 * A metadata value that is a plain object whose keys are all drawn from
 * {@link SUPPORTED_OPS} is treated as an operator query. Otherwise the value
 * falls through to exact match ({@link buildPlainEqualityClause}).
 *
 * Operator queries route through the generated columns maintained by
 * `indexed-fields`: `meta_<field>` on `notes`, backed by a B-tree index, when
 * the field is declared `indexed: true` in some tag schema. Any other field is
 * answered by a scan over the JSON ({@link buildScanClause}), which gives the
 * rows its indexed twin would give, and the caller is told it scanned (the
 * `scan` warning, `query-warnings.ts`). 0.9.2 "filter any field": the decision
 * doc's "no silent fallback" holds because the fallback is never silent.
 *
 * See `Parachute/Decisions/2026-04-19-metadata-indexing-via-tag-schemas`.
 */

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { getIndexedField, type IndexedField, type SqliteType } from "./indexed-fields.js";
import { inViaJsonEachCast, jsonEachParam } from "./sql-in.js";

export const SUPPORTED_OPS = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "not_in",
  "exists",
] as const;

export type QueryOp = (typeof SUPPORTED_OPS)[number];

const OPS_SET: ReadonlySet<string> = new Set<string>(SUPPORTED_OPS);

export class QueryError extends Error {
  override name = "QueryError";
  code: string;
  /**
   * Structured `error_type` for the honest-queries validation errors
   * (vault#550 — `limit`/`offset`/date-value validation). Optional: the
   * long-standing QueryError call sites (FIELD_NOT_INDEXED,
   * UNKNOWN_OPERATOR, generic INVALID_QUERY combos) leave this unset and
   * keep their existing `{error, code}` response shape — only the new #550
   * call sites opt into the richer `{error_type, field, got, hint}` shape.
   */
  error_type?: string;
  field?: string;
  got?: unknown;
  hint?: string;
  constructor(
    message: string,
    code = "INVALID_QUERY",
    extra?: { error_type?: string; field?: string; got?: unknown; hint?: string },
  ) {
    super(message);
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

/**
 * Returns true when `value` is a non-array, non-null, non-empty plain object.
 * The presence of *any* plain-object value commits the caller to operator-
 * parsing: a misspelled operator like `{ bogus: 5 }` is a loud error rather
 * than a silent fallback to JSON-blob exact-match. Nested-object exact-match
 * on the JSON blob was never a meaningful use case.
 */
export function isOperatorObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.keys(value as object).length > 0;
}

export interface PlainEqualityClause {
  /** The match itself, on the JSON. Always safe to run alone. */
  sql: string;
  params: SQLQueryBindings[];
  /**
   * Values for `"meta_<field>" IN (...)` when the field is indexed. Every row
   * `sql` matches holds one of them in its generated column, so the index can
   * narrow the candidates first. Null when no such values exist.
   */
  indexProbes: SQLQueryBindings[] | null;
}

/**
 * Bare `{field: value}` equality on metadata.
 *
 * `json_extract` gives a JSON string as text, a number as a number, true and
 * false as 1 and 0, and null as SQL NULL, and SQLite doesn't convert between
 * text and numbers here. So each value binds the way its JSON type comes out:
 *
 * - string: compared as text. `{x: "5"}` doesn't match a stored 5.
 * - number: compared as a number, on JSON numbers only, so `{x: 1}` doesn't
 *   match a stored `true` (which also comes out as 1).
 * - boolean and null: by `json_type`, so `{x: true}` doesn't match a stored 1,
 *   and `{x: null}` matches a stored null but not a missing key.
 * - array and empty object: compared as their JSON text, which is how
 *   `json_extract` gives them back.
 *
 * Numbers, booleans and null also still match their text form (`{x: true}`
 * finds a stored `"true"`). These filters used to be bound only as that text,
 * so it's the one thing they found; vaults hold such strings, and dropping
 * them would empty a working caller's results with no error.
 */
export function buildPlainEqualityClause(key: string, value: unknown): PlainEqualityClause {
  const path = "'$.' || ?";
  const asText = `json_extract(n.metadata, ${path}) = ?`;
  if (typeof value === "string") {
    return { sql: asText, params: [key, value], indexProbes: [value] };
  }
  const text = JSON.stringify(value);
  if (typeof value === "number") {
    return {
      sql: `(${asText} OR (json_type(n.metadata, ${path}) IN ('integer', 'real') AND json_extract(n.metadata, ${path}) = ?))`,
      params: [key, text, key, key, value],
      indexProbes: [text, value],
    };
  }
  if (typeof value === "boolean" || value === null) {
    return {
      // JSON.stringify(true) is also the name json_type gives it.
      sql: `(${asText} OR json_type(n.metadata, ${path}) = ?)`,
      params: [key, text, key, text],
      // A stored null is NULL in the generated column, which IN can't find.
      indexProbes: value === null ? null : [text, value ? 1 : 0],
    };
  }
  return { sql: asText, params: [key, text], indexProbes: [text] };
}

function validateOperatorObject(field: string, obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    if (!OPS_SET.has(key)) {
      throw new QueryError(
        `unknown operator "${key}" on metadata field "${field}". Supported: ${SUPPORTED_OPS.join(", ")}.`,
        "UNKNOWN_OPERATOR",
      );
    }
  }
}

function toBinding(field: string, op: string, value: unknown): SQLQueryBindings {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  throw new QueryError(
    `operator "${op}" on metadata field "${field}" expects a primitive value (string, number, boolean, bigint, or null), got ${typeof value}`,
    "INVALID_OPERATOR_VALUE",
  );
}

/**
 * Narrow one `in`/`not_in` element to something `JSON.stringify` can carry
 * into {@link jsonEachParam} (vault#536).
 *
 * Runs `toBinding` first so the primitive-only validation and its error
 * message are unchanged from the one-param-per-value era. Then two shapes
 * need explicit handling, because JSON has no equivalent of what bun:sqlite
 * did implicitly when the value was bound directly:
 *
 * - `boolean` → `1`/`0`, matching the INTEGER a boolean is stored as, so
 *   `{ in: [true] }` still matches rows written with `true`. A raw JSON
 *   `true` would come out of `json_each` as `1` anyway on current SQLite,
 *   but converting here makes the intent explicit rather than dependent on
 *   that.
 * - `bigint` → `JSON.stringify` THROWS on it ("Do not know how to serialize
 *   a BigInt"). Converted when it fits exactly in a double; otherwise
 *   rejected with a real error instead of a crash or a silently wrong
 *   comparison. (Unreachable from MCP/REST — `JSON.parse` never yields a
 *   bigint — so this only guards a direct in-process caller.)
 */
function toJsonEachMember(
  field: string,
  op: string,
  value: unknown,
): string | number | boolean | null {
  const bound = toBinding(field, op, value);
  if (typeof bound === "boolean") return bound ? 1 : 0;
  if (typeof bound === "bigint") {
    if (bound >= BigInt(Number.MIN_SAFE_INTEGER) && bound <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(bound);
    }
    throw new QueryError(
      `operator "${op}" on metadata field "${field}" got a bigint outside the safe integer range (${bound}); it cannot be compared exactly`,
      "INVALID_OPERATOR_VALUE",
    );
  }
  // `toBinding` is declared as the full `SQLQueryBindings` union (which
  // includes TypedArray/Record shapes it never actually returns), so narrow
  // to what JSON can carry rather than asserting.
  if (bound === null || typeof bound === "string" || typeof bound === "number") return bound;
  throw new QueryError(
    `operator "${op}" on metadata field "${field}" expects a primitive value (string, number, boolean, bigint, or null)`,
    "INVALID_OPERATOR_VALUE",
  );
}

/**
 * Best-effort lookup of a metadata field's declared `type` across every tag
 * schema — used ONLY to sharpen the {@link requireIndexedField} error hint
 * below when the field was never indexed. Scans `tags.fields` directly
 * rather than going through `indexed_fields` (which by construction has no
 * row for a type that can never BE indexed, e.g. `"number"`) or a
 * per-note schema resolution (scoped to one note's tags, not "any tag
 * anywhere"). Only reached on the FIELD_NOT_INDEXED error path — a full
 * table scan here is fine since it runs once per rejected call, never on a
 * hot path. Returns the type from the FIRST tag found declaring `field`
 * (a cross-tag type conflict on the same field name is its own separate
 * validation elsewhere, not this function's job); `undefined` when no tag
 * declares this field name, or its `fields` JSON doesn't parse.
 */
function findDeclaredFieldType(db: Database, field: string): string | undefined {
  const rows = db.prepare(
    `SELECT fields FROM tags WHERE fields IS NOT NULL`,
  ).all() as { fields: string | null }[];
  for (const row of rows) {
    if (!row.fields) continue;
    try {
      const parsed: unknown = JSON.parse(row.fields);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const spec = (parsed as Record<string, unknown>)[field];
      if (spec === null || typeof spec !== "object" || Array.isArray(spec)) continue;
      const type = (spec as Record<string, unknown>).type;
      if (typeof type === "string") return type;
    } catch {
      // Malformed `fields` JSON on some other tag — not this lookup's job
      // to validate; skip and keep scanning.
    }
  }
  return undefined;
}

/**
 * Look up `field` in `indexed_fields` or throw a loud error suggesting the
 * caller declare it via `update-tag` with `indexed: true`. Since 0.9.2 only
 * `aggregate` (group_by, sum) needs this: filters and order_by scan a field
 * that isn't indexed. Aggregate stays refused because its reply is a bare
 * `[{group, value}]` list with no warnings channel, so a scan there would be
 * silent.
 *
 * That generic advice is IMPOSSIBLE to satisfy for a field whose schema
 * declares `type: "number"` (a float) — only `integer`/`boolean` are
 * indexable numeric shapes (see `indexed-fields.ts`'s `TYPE_MAP`), so
 * `update-tag` with `indexed: true` on a `number` field itself throws
 * "unsupported type ... for indexing". An agent that only sees the generic
 * hint has no escape from that loop (LB — round-4 bug hunt). When the
 * declared type is `"number"`, swap in a hint that names the actual fix:
 * store the value as an integer (e.g. cents instead of dollars) and index
 * THAT field instead.
 */
export function requireIndexedField(db: Database, field: string): IndexedField {
  const row = getIndexedField(db, field);
  if (!row) {
    if (findDeclaredFieldType(db, field) === "number") {
      throw new QueryError(
        `metadata field "${field}" is not indexed, and can never be: it's declared type: "number" (a float), and only integer/boolean fields are indexable numeric types. "declare indexed: true" will not work on this field.`,
        "FIELD_NOT_INDEXED",
        {
          error_type: "field_not_indexed",
          field,
          hint: `"${field}" is a float ("number") field — float fields can't be indexed, so aggregate can't group or sum them (filters and order_by still work, by a scan). Store the value as an integer instead (e.g. cents rather than dollars) and declare indexed: true on THAT field to aggregate it.`,
        },
      );
    }
    throw new QueryError(
      `metadata field "${field}" is not indexed. aggregate's group_by and sum need an indexed field: declare it via update-tag with indexed: true. (Filters and order_by work on any field, by a scan.)`,
      "FIELD_NOT_INDEXED",
    );
  }
  return row;
}

/**
 * Build a SQL fragment + bound params for an operator object on an indexed
 * metadata field. Each operator maps to a single AND clause; an object like
 * `{ gt: 5, lt: 10 }` composes as `meta_<field> > 5 AND meta_<field> < 10`.
 *
 * `sqliteType` is the field's declared column storage type (from
 * `requireIndexedField(...).sqliteType`, which every caller already
 * resolves). It's needed for `in`/`not_in`: those bind the value-set through
 * a `json_each` subquery, which — unlike a placeholder `IN (?, …)` list —
 * does NOT apply the left column's type affinity to each candidate value, so
 * the set must be CAST to the column's type to keep cross-type matches like
 * numeric `5` against a TEXT-affinity `'5'` (vault#676).
 */
export function buildOperatorClause(
  field: string,
  opObj: Record<string, unknown>,
  sqliteType: SqliteType,
): { sql: string; params: SQLQueryBindings[] } {
  validateOperatorObject(field, opObj);
  // `field` came from indexed_fields (which validated it via FIELD_NAME_RE
  // when the declaration was recorded), so interpolating it into the column
  // name is safe.
  const col = `"meta_${field}"`;
  const parts: string[] = [];
  const params: SQLQueryBindings[] = [];

  for (const [op, value] of Object.entries(opObj)) {
    switch (op as QueryOp) {
      case "eq":
        if (value === null) {
          parts.push(`${col} IS NULL`);
        } else {
          parts.push(`${col} = ?`);
          params.push(toBinding(field, op, value));
        }
        break;
      case "ne":
        if (value === null) {
          parts.push(`${col} IS NOT NULL`);
        } else {
          // Preserve "field is set AND not equal" semantics — SQLite's `<>`
          // returns NULL (not true) when the LHS is NULL, so a notes row
          // that has no value for the field would be silently excluded. Be
          // explicit: either the column is null, or the values differ.
          parts.push(`(${col} IS NULL OR ${col} <> ?)`);
          params.push(toBinding(field, op, value));
        }
        break;
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        const sym = op === "gt" ? ">" : op === "gte" ? ">=" : op === "lt" ? "<" : "<=";
        parts.push(`${col} ${sym} ?`);
        params.push(toBinding(field, op, value));
        break;
      }
      case "in":
      case "not_in": {
        if (!Array.isArray(value)) {
          throw new QueryError(
            `operator "${op}" on metadata field "${field}" expects an array`,
            "INVALID_OPERATOR_VALUE",
          );
        }
        if (value.length === 0) {
          // Empty IN is a contradiction; empty NOT IN is a no-op. Emit SQL
          // that matches these semantics without running a parameterless
          // `IN ()` (which is a syntax error in SQLite).
          parts.push(op === "in" ? "0" : "1");
          break;
        }
        // ONE bound param for the whole set, regardless of its size
        // (vault#536). This used to emit `IN (?, ?, …)` — one param per
        // value — which on Cloudflare Durable Object SQLite (100 bound
        // params per statement, vs bun:sqlite's 999+) turned any `in` array
        // over ~100 elements into a `too many SQL variables` 500 on cloud
        // vaults, while self-host never noticed.
        //
        // This is an EMBEDDED filter inside a paginated statement, so the
        // chunk-and-union approach used for standalone id-lists isn't
        // available — chunking would break the shared LIMIT/OFFSET window.
        // The json_each shape #535 introduced for the `near` neighborhood is
        // the one that works here: bind the array as a single JSON param and
        // let SQLite expand it into a one-column table. See sql-in.ts.
        //
        // Every element still goes through `toBinding`, so the same
        // primitive-only validation (and the same error message) applies as
        // before — the values are just serialized into JSON instead of bound
        // one by one.
        //
        // The set is CAST to the column's declared storage type inside the
        // subquery (`inViaJsonEachCast`). A placeholder `IN (?, …)` list got
        // the left column's affinity applied to each value for free; a
        // `json_each` subquery does not, so without the CAST a numeric `5`
        // silently stopped matching a TEXT-affinity `'5'` (vault#676). The
        // CAST restores that in both directions and covers `in` and `not_in`.
        const members = value.map((v) => toJsonEachMember(field, op, v));
        const inClause = inViaJsonEachCast(sqliteType);
        if (op === "in") {
          parts.push(`${col} IN ${inClause}`);
        } else {
          parts.push(`(${col} IS NULL OR ${col} NOT IN ${inClause})`);
        }
        params.push(jsonEachParam(members));
        break;
      }
      case "exists":
        if (typeof value !== "boolean") {
          throw new QueryError(
            `operator "exists" on metadata field "${field}" expects a boolean`,
            "INVALID_OPERATOR_VALUE",
          );
        }
        parts.push(value ? `${col} IS NOT NULL` : `${col} IS NULL`);
        break;
    }
  }

  return {
    sql: parts.length === 1 ? parts[0]! : `(${parts.join(" AND ")})`,
    params,
  };
}

// ---------------------------------------------------------------------------
// Scans: operators and order_by on a field that isn't indexed (0.9.2)
// ---------------------------------------------------------------------------

/**
 * How a scanned field compares, chosen to match what an indexed column of the
 * same declared type would do. An indexed field is a generated column with a
 * type affinity (`TEXT` or `INTEGER`, `indexed-fields.ts` TYPE_MAP), and SQLite
 * converts both the stored value and the operand by that affinity. A scan has
 * no column, so it applies the same conversions in the expression:
 *
 * - `TEXT` (declared `string`, `date`, `reference`): both sides compare as text.
 * - `NUMERIC` (declared `integer`, `boolean`, `number`; and a field no type
 *   declares): a number, or text that reads as a number, compares as a number;
 *   other text compares as text. For a declared integer this is what the
 *   INTEGER column does. A `number` (float) field can't be indexed, so it has
 *   no twin; numeric is the only reading that makes `gt: 4.5` mean anything.
 *   An undeclared field gets SQLite's own default for a column with no known
 *   type, NUMERIC, so `meta[x][gt]=5` from a query string (always text) still
 *   compares with a stored 3 as a number.
 */
export type ScanAffinity = "TEXT" | "NUMERIC";

export function scanAffinityFor(db: Database, field: string): ScanAffinity {
  const type = findDeclaredFieldType(db, field);
  return type === "string" || type === "date" || type === "reference" ? "TEXT" : "NUMERIC";
}

/** True when `value` is a number, or text SQLite's numeric affinity would turn into one. */
function numericLike(value: unknown): boolean {
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return true;
  return typeof value === "string" && /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(value);
}

/**
 * `json_extract` of one top-level key, with the path written the way the
 * indexed column's own expression writes it (`'$."<field>"'`), so a key with a
 * dot or a space names that key and not a nested path. The key goes into a SQL
 * string literal (quotes doubled); a key holding a double quote or a control
 * character can't be written as a JSON path label, so it's refused.
 */
export function scanValueSql(field: string): string {
  if (/["\u0000-\u001f\\]/.test(field)) {
    throw new QueryError(
      `metadata field "${field}" can't be filtered or sorted on: its name holds a quote, backslash or control character`,
      "INVALID_QUERY",
      { error_type: "invalid_query", field, hint: "rename the field (or migrate it) to a plain name" },
    );
  }
  return `json_extract(n.metadata, '$."${field.replace(/'/g, "''")}"')`;
}

/**
 * The scan twin of {@link buildOperatorClause}: the same operators, NULL and
 * missing-key handling (`ne`/`not_in` match a record without the field,
 * `exists:false` matches it), on the JSON value with {@link ScanAffinity}'s
 * conversions. Every record the other filters leave is read.
 */
export function buildScanClause(
  field: string,
  opObj: Record<string, unknown>,
  affinity: ScanAffinity,
): { sql: string; params: SQLQueryBindings[] } {
  validateOperatorObject(field, opObj);
  const raw = scanValueSql(field);
  // TEXT: a CAST expression carries TEXT affinity, so SQLite turns the operand
  // into text too, as it does against a TEXT column. NUMERIC: the operand is
  // CAST to NUMERIC when it reads as a number, which gives the comparison
  // NUMERIC affinity and converts a stored "5" on the left (losslessly: affinity
  // only converts text that is a well-formed number).
  const lhs = affinity === "TEXT" ? `CAST(${raw} AS TEXT)` : raw;
  const rhs = (v: unknown) => (affinity === "NUMERIC" && numericLike(v) ? "CAST(? AS NUMERIC)" : "?");
  // A NUMERIC field compared with text that isn't a number: no affinity
  // applies, so the stored value is converted first (the sort key does
  // exactly what the column's affinity does), and a stored "70" is the
  // number 70 against "6x", as in an INTEGER column.
  const converted = affinity === "NUMERIC" ? scanOrderSql(field, "NUMERIC") : lhs;
  const lhsFor = (v: unknown) => (numericLike(v) ? lhs : converted);
  const parts: string[] = [];
  const params: SQLQueryBindings[] = [];

  const inSet = (members: (string | number | boolean | null)[]): string => {
    if (affinity === "TEXT") {
      params.push(jsonEachParam(members));
      return `${lhs} IN ${inViaJsonEachCast("TEXT")}`;
    }
    const nums = members.filter(numericLike);
    const rest = members.filter((m) => !numericLike(m));
    const ors: string[] = [];
    if (nums.length > 0) {
      ors.push(`${lhs} IN (SELECT CAST(value AS NUMERIC) FROM json_each(?))`);
      params.push(jsonEachParam(nums));
    }
    if (rest.length > 0) {
      ors.push(`${converted} IN (SELECT value FROM json_each(?))`);
      params.push(jsonEachParam(rest));
    }
    return ors.length === 1 ? ors[0]! : `(${ors.join(" OR ")})`;
  };

  for (const [op, value] of Object.entries(opObj)) {
    switch (op as QueryOp) {
      case "eq":
        if (value === null) {
          parts.push(`${raw} IS NULL`);
        } else {
          parts.push(`${lhsFor(value)} = ${rhs(value)}`);
          params.push(toBinding(field, op, value));
        }
        break;
      case "ne":
        if (value === null) {
          parts.push(`${raw} IS NOT NULL`);
        } else {
          parts.push(`(${raw} IS NULL OR ${lhsFor(value)} <> ${rhs(value)})`);
          params.push(toBinding(field, op, value));
        }
        break;
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        const sym = op === "gt" ? ">" : op === "gte" ? ">=" : op === "lt" ? "<" : "<=";
        parts.push(`${lhsFor(value)} ${sym} ${rhs(value)}`);
        params.push(toBinding(field, op, value));
        break;
      }
      case "in":
      case "not_in": {
        if (!Array.isArray(value)) {
          throw new QueryError(
            `operator "${op}" on metadata field "${field}" expects an array`,
            "INVALID_OPERATOR_VALUE",
          );
        }
        if (value.length === 0) {
          parts.push(op === "in" ? "0" : "1");
          break;
        }
        const members = value.map((v) => toJsonEachMember(field, op, v));
        const set = inSet(members);
        parts.push(op === "in" ? set : `(${raw} IS NULL OR NOT ${set})`);
        break;
      }
      case "exists":
        if (typeof value !== "boolean") {
          throw new QueryError(
            `operator "exists" on metadata field "${field}" expects a boolean`,
            "INVALID_OPERATOR_VALUE",
          );
        }
        parts.push(value ? `${raw} IS NOT NULL` : `${raw} IS NULL`);
        break;
    }
  }

  return {
    sql: parts.length === 1 ? parts[0]! : `(${parts.join(" AND ")})`,
    params,
  };
}

/**
 * The sort key for `order_by` on a field that isn't indexed: the JSON value
 * converted the way the indexed column would hold it. TEXT: as text. NUMERIC:
 * text that NUMERIC affinity converts sorts as that number (`"5"` among 3 and
 * 8), anything else as itself, so numbers come before text as they do in an
 * INTEGER column.
 */
export function scanOrderSql(field: string, affinity: ScanAffinity): string {
  const raw = scanValueSql(field);
  if (affinity === "TEXT") return `CAST(${raw} AS TEXT)`;
  // `x = CAST(x AS NUMERIC)` is true for text exactly when NUMERIC affinity
  // would convert it: the CAST side carries NUMERIC affinity, so SQLite
  // applies that affinity to x before comparing, and text that isn't a
  // well-formed number stays text and can't equal a number. So `"08"`, `" 5"`
  // and `"1e2"` sort as 8, 5 and 100, as the filter (and an INTEGER column)
  // reads them; `"1-2"` and `"abc"` stay text.
  return `(CASE WHEN typeof(${raw}) = 'text' AND ${raw} = CAST(${raw} AS NUMERIC) THEN CAST(${raw} AS NUMERIC) ELSE ${raw} END)`;
}

// ---------------------------------------------------------------------------
// In-memory operator evaluation (vault#299 — value-matched triggers)
// ---------------------------------------------------------------------------

/**
 * Evaluate an operator object against a single in-memory value — the
 * non-SQL twin of {@link buildOperatorClause}. The trigger engine fires on a
 * live `note.metadata` object (not a DB row), so it can't route through the
 * indexed generated columns; this gives it the SAME operator vocabulary +
 * semantics without re-implementing them. An object with multiple operators
 * is AND-composed (`{ gt: 5, lt: 10 }`), matching the SQL clause builder.
 *
 * `value` is the field's current value (`undefined` when the field is
 * absent). Semantics mirror the SQL builder, including the NULL/missing
 * handling: `ne`/`not_in` treat an absent/null value as "matches" (the SQL
 * `(col IS NULL OR ...)` shape); `eq: null` matches an absent/null value.
 *
 * Throws `QueryError` on an unknown operator or a malformed operand — the
 * trigger validator surfaces it as a 400 at registration time.
 */
export function matchesOperator(
  field: string,
  value: unknown,
  opObj: Record<string, unknown>,
): boolean {
  validateOperatorObject(field, opObj);
  const absent = value === undefined || value === null;

  for (const [op, operand] of Object.entries(opObj)) {
    switch (op as QueryOp) {
      case "eq":
        if (operand === null) {
          if (!absent) return false;
        } else if (absent || !looseEquals(value, operand)) {
          return false;
        }
        break;
      case "ne":
        if (operand === null) {
          if (absent) return false;
        } else if (!absent && looseEquals(value, operand)) {
          return false;
        }
        break;
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        if (absent) return false;
        const cmp = compareScalar(value, operand);
        if (cmp === null) return false;
        if (op === "gt" && !(cmp > 0)) return false;
        if (op === "gte" && !(cmp >= 0)) return false;
        if (op === "lt" && !(cmp < 0)) return false;
        if (op === "lte" && !(cmp <= 0)) return false;
        break;
      }
      case "in":
      case "not_in": {
        if (!Array.isArray(operand)) {
          throw new QueryError(
            `operator "${op}" on metadata field "${field}" expects an array`,
            "INVALID_OPERATOR_VALUE",
          );
        }
        const present = !absent && operand.some((o) => looseEquals(value, o));
        if (op === "in" && !present) return false;
        // not_in: absent/null matches (mirrors SQL `col IS NULL OR ...`).
        if (op === "not_in" && present) return false;
        break;
      }
      case "exists":
        if (typeof operand !== "boolean") {
          throw new QueryError(
            `operator "exists" on metadata field "${field}" expects a boolean`,
            "INVALID_OPERATOR_VALUE",
          );
        }
        if (operand === !absent) break;
        return false;
    }
  }
  return true;
}

/**
 * Loose scalar equality used by in-memory `eq`/`ne`/`in`. Matches SQLite's
 * affinity-tolerant comparison closely enough for trigger value-matching:
 * exact for same-type scalars; cross-type number/string compares by string
 * form (`5` matches `"5"`), since metadata round-trips through JSON and a
 * note may carry either shape.
 */
function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    (typeof a === "number" || typeof a === "string") &&
    (typeof b === "number" || typeof b === "string")
  ) {
    return String(a) === String(b);
  }
  return false;
}

/**
 * Three-way comparison for ordered operators (gt/gte/lt/lte). Returns a
 * negative/zero/positive number, or `null` when the operands aren't
 * order-comparable (so the caller treats it as "no match"). Numbers compare
 * numerically; strings lexicographically; mixed types don't compare.
 */
function compareScalar(a: unknown, b: unknown): number | null {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return null;
}
