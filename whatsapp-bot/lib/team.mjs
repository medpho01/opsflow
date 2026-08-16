/**
 * LS team roster matcher — shared by ingest (to tell a team RESPONSE from a
 * customer QUERY) and the analyst. Cached 60s. Matches on phone (last 10 of the
 * jid) or normalized name/alias.
 */
import { taskosQuery } from "./taskosdb.mjs";

let cache = { at: 0, list: [] };
export async function loadTeam() {
  if (Date.now() - cache.at < 60_000) return cache.list;
  try {
    cache = { at: Date.now(), list: (await taskosQuery(`SELECT name, phone, aliases FROM wa_contacts WHERE active = true`)).rows };
  } catch { /* table may be empty */ }
  return cache.list;
}

const last10 = (s) => (s || "").replace(/\D/g, "").slice(-10);

export function makeTeamMatcher(team) {
  const byPhone = new Map(), byName = new Map();
  for (const t of team) {
    if (t.phone) byPhone.set(last10(t.phone), t.name);
    if (t.name) byName.set(t.name.toLowerCase().trim(), t.name);
    for (const a of t.aliases || []) byName.set(String(a).toLowerCase().trim(), t.name);
  }
  return (sender, senderJid) => {
    const d = last10((senderJid || "").split("@")[0]);
    if (d && byPhone.has(d)) return byPhone.get(d);
    const n = (sender || "").toLowerCase().trim();
    if (n && byName.has(n)) return byName.get(n);
    return null;
  };
}
