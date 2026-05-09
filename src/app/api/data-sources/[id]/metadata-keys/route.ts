/**
 * GET /api/data-sources/{id}/metadata-keys?sample=25
 *
 * Returns the set of metadata field paths that have been OBSERVED on recent
 * rows of the source's underlying table. Used by the rule editor's metadata-
 * condition autocomplete (W4.3) so authors don't type `phleboNots` and watch
 * the rule silently never match.
 *
 * What "metadata keys" means here:
 *   - Every column on the source table is a candidate key (the engine's
 *     metadata object is built from RawOrder fields like patientName,
 *     orderStatus, appointmentTime — these are columns).
 *   - If a column is JSONB (e.g. `metadata`, `rawValues`), we walk its
 *     contents and surface dot-paths (`metadata.reportETA`, `metadata.notes.priority`).
 *   - We sample the last N rows (default 25, capped 100) ordered by the
 *     primary key DESC so freshly-introduced fields are visible without
 *     scanning the whole table.
 *
 * Response shape:
 *   {
 *     keys: [
 *       { path: "patientName",       type: "string", sampleValue: "Karthi V", observedIn: 25 },
 *       { path: "metadata.reportETA", type: "timestamp", sampleValue: "2026-...", observedIn: 14 },
 *       ...
 *     ],
 *     sampledRows: 25
 *   }
 *
 * Deliberately heuristic — type inference is best-effort (string/number/
 * boolean/timestamp/object/null) so authors get a hint, not a contract.
 */

import { NextRequest, NextResponse } from "next/server";
import { Prisma, UserRole } from "@prisma/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { isValidTableReference, bareTableName } from "@/lib/validation/data-sources";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";

const DEFAULT_SAMPLE = 25;
const MAX_SAMPLE = 100;

type KnownType = "string" | "number" | "boolean" | "timestamp" | "object" | "array" | "null";

interface KeyEntry {
  path: string;
  type: KnownType;
  sampleValue: unknown;
  observedIn: number;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = newRequestId();
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized", requestId }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden", requestId }, { status: 403 });
  }

  const { id } = await params;

  const url = new URL(request.url);
  const rawSample = parseInt(url.searchParams.get("sample") ?? String(DEFAULT_SAMPLE), 10);
  const sampleSize = Math.min(MAX_SAMPLE, Math.max(1, isNaN(rawSample) ? DEFAULT_SAMPLE : rawSample));

  try {
    const dataSource = await prisma.dataSource.findUnique({
      where: { id },
      select: { tableReference: true, primaryKeyField: true, displayName: true },
    });
    if (!dataSource) {
      return NextResponse.json({ error: "Data source not found", code: "NOT_FOUND", requestId }, { status: 404 });
    }
    if (!isValidTableReference(dataSource.tableReference)) {
      return NextResponse.json(
        { error: "Source has an invalid tableReference", code: "INVALID_SOURCE_CONFIG", requestId },
        { status: 400 }
      );
    }

    // ─── Sample recent rows ──────────────────────────────────────────────
    // tableReference + primaryKeyField were validated when the source was
    // registered (see lib/validation/data-sources.ts). The values reach
    // Prisma.raw via that whitelist. The LIMIT is a number param.
    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT * FROM ${Prisma.raw(dataSource.tableReference)}
      ORDER BY ${Prisma.raw(`"${dataSource.primaryKeyField}"`)} DESC
      LIMIT ${sampleSize}
    `);

    // ─── Walk columns + flatten JSONB values ─────────────────────────────
    const observed = new Map<string, { count: number; firstNonNullValue: unknown; type: KnownType }>();

    for (const row of rows) {
      // Top-level columns
      for (const [col, value] of Object.entries(row)) {
        track(observed, col, value);

        // If a column is an object/array (JSONB), walk one level of paths.
        // Two levels in is plenty for most metadata patterns; deeper nesting
        // is rare and explorable with the column itself.
        if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
          for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
            track(observed, `${col}.${subKey}`, subValue);
          }
        }
      }
    }

    // Sort keys: top-level first (no dot), then alphabetical inside each group,
    // so the canonical fields the engine actually emits float to the top.
    const keys: KeyEntry[] = Array.from(observed.entries())
      .map(([path, info]) => ({
        path,
        type: info.type,
        sampleValue: serializableSample(info.firstNonNullValue),
        observedIn: info.count,
      }))
      .sort((a, b) => {
        const aDotted = a.path.includes(".");
        const bDotted = b.path.includes(".");
        if (aDotted !== bDotted) return aDotted ? 1 : -1;
        return a.path.localeCompare(b.path);
      });

    return NextResponse.json({
      sourceId: id,
      sourceName: dataSource.displayName,
      sampledRows: rows.length,
      keys,
      requestId,
    });
  } catch (error) {
    return NextResponse.json(
      logAndBuildErrorBody({
        requestId,
        scope: "DataSourcesAPI.metadata-keys",
        code: "METADATA_KEYS_ERROR",
        userMessage: "Failed to introspect metadata keys",
        error,
      }),
      { status: 500 }
    );
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function track(
  m: Map<string, { count: number; firstNonNullValue: unknown; type: KnownType }>,
  path: string,
  value: unknown
) {
  const existing = m.get(path);
  if (!existing) {
    m.set(path, {
      count: value === null || value === undefined ? 0 : 1,
      firstNonNullValue: value === null || value === undefined ? null : value,
      type: inferType(value),
    });
    return;
  }
  if (value !== null && value !== undefined) {
    existing.count++;
    if (existing.firstNonNullValue === null) {
      existing.firstNonNullValue = value;
      existing.type = inferType(value);
    }
  }
}

function inferType(v: unknown): KnownType {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number" || typeof v === "bigint") return "number";
  if (v instanceof Date) return "timestamp";
  if (typeof v === "string") {
    // Heuristic: ISO-shaped strings = timestamp.
    if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/.test(v) && !isNaN(Date.parse(v))) return "timestamp";
    return "string";
  }
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  return "string";
}

function serializableSample(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string" && v.length > 80) return v.slice(0, 80) + "…";
  if (v && typeof v === "object") {
    try {
      const json = JSON.stringify(v);
      return json.length > 80 ? json.slice(0, 80) + "…" : json;
    } catch {
      return "[unserializable]";
    }
  }
  return v;
}
