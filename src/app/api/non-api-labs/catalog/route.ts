/**
 * GET /api/non-api-labs/catalog — every lab LabStack knows about, with whatever
 * provider-communication configuration OpsFlow holds for it.
 *
 * The roster comes from LabStack rather than from what somebody remembered to
 * type in, so a lab nobody has configured yet is visible instead of absent.
 *
 * Two shapes:
 *   ?page=N&…   one page of the Lab Config list — searched, filtered and
 *               sorted on the server (see lib/non-api-labs/lab-catalog.ts).
 *               Params: q, status, type, includeInactive, sort, dir, page,
 *               pageSize, refresh.
 *   no `page`   every lab, unpaged — kept for callers that need the whole
 *               roster in one go.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";
import {
  buildRows, loadOpsflowSide, loadSourceLabs, queryCatalog,
  LAB_SETUP_STATUSES, type CatalogQuery, type CatalogSort,
} from "@/lib/non-api-labs/lab-catalog";

const SORTS: CatalogSort[] = ["fulfilled", "open", "name", "id"];

function parseQuery(params: URLSearchParams): CatalogQuery {
  const status = params.get("status") ?? "ALL";
  const type = params.get("type") ?? "ALL";
  const sort = params.get("sort") as CatalogSort | null;
  const dir = params.get("dir");
  return {
    q: params.get("q") ?? "",
    status: (["ALL", "CONFIGURED", ...LAB_SETUP_STATUSES] as string[]).includes(status) ? status as CatalogQuery["status"] : "ALL",
    type: type === "NON_API" || type === "API" ? type : "ALL",
    includeInactive: params.get("includeInactive") === "1",
    sort: sort && SORTS.includes(sort) ? sort : "fulfilled",
    dir: dir === "asc" || dir === "desc" ? dir : undefined,
    page: Number(params.get("page")) || 1,
    pageSize: Number(params.get("pageSize")) || 25,
  };
}

export async function GET(request: NextRequest) {
  const requestId = newRequestId();
  try {
    const user = await getSessionFromRequest(request);
    if (!user || user.role !== UserRole.OPS_HEAD) {
      return NextResponse.json({ error: "Unauthorized", code: "FORBIDDEN", requestId }, { status: 403 });
    }

    const params = request.nextUrl.searchParams;
    const [sourceLabs, { configs, groups }] = await Promise.all([
      loadSourceLabs(params.get("refresh") === "1"),
      loadOpsflowSide(),
    ]);
    const rows = buildRows(sourceLabs, configs, groups);

    // groups ship alongside so the editor can offer a picker.
    if (!params.has("page")) return NextResponse.json({ labs: rows, groups });
    return NextResponse.json({ ...queryCatalog(rows, parseQuery(params)), groups });
  } catch (error) {
    return NextResponse.json(
      logAndBuildErrorBody({
        requestId,
        scope: "NonApiLabsCatalogAPI.GET",
        code: "FETCH_ERROR",
        userMessage: "Failed to load the lab catalogue",
        error,
      }),
      { status: 500 },
    );
  }
}
