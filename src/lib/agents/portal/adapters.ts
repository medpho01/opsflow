/**
 * Portal adapters (DESIGN.md §4.12, FR-17): one per partner portal, each a
 * small script — log in, check the session, read one order by its lab
 * reference. The GENERIC adapter is configured with selectors and field
 * patterns per lab from the Controls page, so a new portal needs no code
 * until its pages prove unusual. Parsing is pure and tested on fixtures;
 * the browser driving lives in src/portal-worker.
 */
export type PortalFields = {
  phleboName?: string | null; phleboPhone?: string | null; phleboStatus?: string | null;
  sampleCollected?: boolean | null; sampleReceived?: boolean | null;
  reportStatus?: "none" | "partial" | "full" | null; missingTests?: string[] | null;
  rescheduleReason?: string | null; rnr?: boolean | null; eta?: string | null;
  rawStatus?: string | null;
};

export type AdapterConfig = {
  /** Where to log in and how. */
  loginUrl: string;
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
  /** Something that exists only when logged in (a menu, a logout link). */
  loggedInSelector: string;
  /** Order page: either a URL with {ref} or a search box. */
  orderUrl?: string;
  searchUrl?: string;
  searchSelector?: string;
  searchSubmitSelector?: string;
  /** The element whose text holds the order's details (a card, a table row). */
  detailSelector: string;
  /** Optional per-field regexes over the detail text; defaults below. */
  patterns?: Partial<Record<keyof PortalFields, string>>;
};

export const DEFAULT_PATTERNS: Record<string, RegExp> = {
  rawStatus: /\b(status|order status)\s*[:\-]\s*([A-Za-z _\-]+)/i,
  phleboName: /\b([Pp]hlebo(?:tomist)?|[Tt]echnician|[Cc]ollector)\s*(?:[Nn]ame)?\s*[:\-]\s*([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/,
  phleboPhone: /\b(?:phlebo|technician|collector)[^\d]{0,40}(\b[6-9]\d{9}\b)/i,
  sampleCollected: /\b(sample\s+collected|collected\s+at|collection\s+done|sample\s+picked)/i,
  sampleReceived: /\b(sample\s+received|received\s+at\s+lab|accessioned|at\s+lab)/i,
  reportFull: /\b(report\s+(?:ready|delivered|uploaded|complete|available)|final\s+report)/i,
  reportPartial: /\b(partial(?:ly)?\s+(?:report|delivered|ready)|interim\s+report)/i,
  missingTests: /\b(?:pending|missing|awaited)\s*(?:tests?|parameters?)\s*[:\-]\s*([^\n]+)/i,
  rnr: /\b(rnr|ringing\s+no\s+response|not\s+reachable|no\s+response|switched\s+off)/i,
  rescheduleReason: /\b(?:reschedul\w*|postpon\w*)\s*(?:reason)?\s*[:\-]\s*([^\n]+)/i,
  eta: /\b(?:eta|expected\s+(?:by|at)|reaching\s+(?:by|at))\s*[:\-]?\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i,
};

/** Read the fields a portal shows out of the order's detail text. Pure. */
export function parsePortalText(text: string, patterns: AdapterConfig["patterns"] = {}): PortalFields {
  const re = (k: string) => (patterns?.[k as keyof PortalFields] ? new RegExp(patterns[k as keyof PortalFields]!, "i") : DEFAULT_PATTERNS[k]);
  const t = text.replace(/\s+/g, " ");
  const grab = (k: string, group = 1): string | null => { const m = t.match(re(k)); return m ? (m[group] ?? m[0]).trim() : null; };
  const has = (k: string) => re(k).test(t);
  const full = has("reportFull"); const partial = has("reportPartial");
  const missing = grab("missingTests");
  return {
    rawStatus: grab("rawStatus", 2),
    phleboName: grab("phleboName", 2),
    phleboPhone: grab("phleboPhone"),
    sampleCollected: has("sampleCollected") ? true : null,
    sampleReceived: has("sampleReceived") ? true : null,
    reportStatus: full && !missing ? "full" : partial || missing ? "partial" : null,
    missingTests: missing ? missing.split(/[,;]/).map((s) => s.trim()).filter(Boolean) : null,
    rnr: has("rnr") ? true : null,
    rescheduleReason: grab("rescheduleReason"),
    eta: grab("eta"),
  };
}

/** Portal facts → the reply-fact kinds the journey understands, with source "portal" and confidence 0.95. */
export function portalFieldsToFacts(f: PortalFields): Array<{ kind: string; value: string }> {
  const out: Array<{ kind: string; value: string }> = [];
  if (f.phleboName) out.push({ kind: "phlebo_name", value: f.phleboName });
  if (f.phleboPhone) out.push({ kind: "phlebo_phone", value: f.phleboPhone });
  if (f.eta) out.push({ kind: "eta", value: f.eta });
  if (f.sampleCollected) out.push({ kind: "sample_collected", value: "collected (portal)" });
  if (f.sampleReceived) out.push({ kind: "sample_delivered", value: "received at lab (portal)" });
  if (f.reportStatus === "full") out.push({ kind: "report_shared", value: "full report on the portal" });
  if (f.reportStatus === "partial") out.push({ kind: "note", value: `partial report on the portal${f.missingTests?.length ? `; pending: ${f.missingTests.join(", ")}` : ""}` });
  if (f.rnr) out.push({ kind: "patient_unavailable", value: "RNR on the portal" });
  if (f.rescheduleReason) out.push({ kind: "delay_reason", value: f.rescheduleReason });
  return out;
}

/** Adapter configs that ship; selectors are placeholders to confirm on the real portal at setup (Controls › Portals). */
export const ADAPTER_PRESETS: Record<string, Partial<AdapterConfig> & { name: string }> = {
  generic: { name: "Generic (configure selectors)" },
  orange: { name: "Orange Health partner portal", loginUrl: "[PORTAL LOGIN URL]", usernameSelector: "input[type=email], input[name=username]", passwordSelector: "input[type=password]", submitSelector: "button[type=submit]", loggedInSelector: "[data-logout], a[href*=logout]", searchUrl: "[PORTAL ORDERS URL]", searchSelector: "input[type=search]", searchSubmitSelector: "button[type=submit]", detailSelector: "main" },
  thyrocare: { name: "Thyrocare ThyroNXT", loginUrl: "[PORTAL LOGIN URL]", usernameSelector: "input[name=username]", passwordSelector: "input[type=password]", submitSelector: "button[type=submit]", loggedInSelector: "a[href*=logout]", detailSelector: "main" },
  redcliffe: { name: "Redcliffe partner portal", loginUrl: "[PORTAL LOGIN URL]", usernameSelector: "input[name=username], input[type=email]", passwordSelector: "input[type=password]", submitSelector: "button[type=submit]", loggedInSelector: "a[href*=logout]", detailSelector: "main" },
};
