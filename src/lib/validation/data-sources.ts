/**
 * Shared validators for the Data Sources API surface.
 *
 * These guards are defence-in-depth. The SQL queries that consume
 * sourceId/tableReference/column names use parameterised Prisma.sql today,
 * so injection is already mitigated at the query layer — but accepting
 * unsanitised identifiers would still let a malicious POST persist values
 * that break downstream queries or render incorrectly. Validate at the door.
 */

/**
 * Strict SQL identifier — matches what PostgreSQL accepts as an unquoted
 * identifier: starts with a letter or underscore, then letters/digits/underscores.
 * Length is also bounded to PG's 63-char NAMEDATALEN limit.
 */
const SQL_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

/** Source IDs — same shape as identifiers; we use them as keys in places. */
const SOURCE_ID = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

/**
 * Table reference — accepts the four common shapes:
 *   - `Order`
 *   - `public.Order`
 *   - `public."Order"`
 *   - `"public"."Order"`
 * Rejects anything else (no commas, semicolons, parentheses, whitespace,
 * SQL keywords mid-string, etc.).
 */
const TABLE_REFERENCE = /^(?:"[a-zA-Z_][a-zA-Z0-9_]*"|[a-zA-Z_][a-zA-Z0-9_]*)(?:\.(?:"[a-zA-Z_][a-zA-Z0-9_]*"|[a-zA-Z_][a-zA-Z0-9_]*))?$/;

export function isValidSqlIdentifier(name: unknown): name is string {
  return typeof name === "string" && SQL_IDENTIFIER.test(name);
}

export function isValidSourceId(id: unknown): id is string {
  return typeof id === "string" && SOURCE_ID.test(id);
}

export function isValidTableReference(ref: unknown): ref is string {
  return typeof ref === "string" && TABLE_REFERENCE.test(ref);
}

/**
 * Strip schema prefix + quotes to get the bare table name.
 * Only call after `isValidTableReference` has passed — assumes well-formed input.
 */
export function bareTableName(tableReference: string): string {
  return tableReference
    .replace(/^[^."]+\."?/, "") // strip schema prefix e.g. public."
    .replace(/"$/, "");          // strip trailing quote
}

/**
 * Polling interval — minutes. 1 minute floor (anything lower DOSes the DB),
 * 1440 (24h) ceiling. Caller decides what to do with `null` (use default).
 */
export const POLLING_INTERVAL_MIN = 1;
export const POLLING_INTERVAL_MAX = 1440;

export function isValidPollingInterval(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= POLLING_INTERVAL_MIN &&
    value <= POLLING_INTERVAL_MAX
  );
}

/** Backfill days — 0 means "no backfill" (legitimate); cap at 365. */
export function isValidBackfillDays(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 365
  );
}

/**
 * The query template must be a read-only SELECT against a single table.
 * Reject anything that looks like DDL/DML or chained statements.
 *
 * This is a defence-in-depth check; the polling engine still runs the query
 * with a read-only DB user in production. But persisting a bad template should
 * fail closed at the API.
 */
const FORBIDDEN_KEYWORDS = [
  "INSERT", "UPDATE", "DELETE", "DROP", "TRUNCATE", "ALTER",
  "CREATE", "GRANT", "REVOKE", "EXECUTE", "CALL", "MERGE",
  "COPY", "VACUUM", "ANALYZE", "REINDEX",
];

export function isReadOnlyQueryTemplate(template: unknown): template is string {
  if (typeof template !== "string") return false;
  const trimmed = template.trim();
  if (!trimmed) return false;
  // Must start with SELECT or WITH (CTE).
  if (!/^(SELECT|WITH)\b/i.test(trimmed)) return false;
  // No semicolons except possibly a trailing one with nothing after it.
  const withoutTrailingSemi = trimmed.replace(/;\s*$/, "");
  if (withoutTrailingSemi.includes(";")) return false;
  // No forbidden keywords as standalone words.
  const upper = ` ${withoutTrailingSemi.toUpperCase()} `;
  for (const kw of FORBIDDEN_KEYWORDS) {
    if (upper.includes(` ${kw} `)) return false;
  }
  return true;
}

/**
 * Build a structured 400 response for any validation failure.
 * Standardises the shape across all data-source endpoints.
 */
export interface ValidationFailure {
  error: string;
  code: "VALIDATION_ERROR";
  details: { field: string; reason: string };
}

export function validationError(field: string, reason: string): ValidationFailure {
  return {
    error: "Validation failed",
    code: "VALIDATION_ERROR",
    details: { field, reason },
  };
}
