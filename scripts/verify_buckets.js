// Verifies Smart View bucketing end-to-end against the live API.
// Asserts the SQL ?view= filter agrees with the JS computeViewBucket
// (every task returned by ?view=X must have viewBucket===X) and flags
// any bucket truncated by the row cap.
const BASE = process.env.OPSFLOW_BASE || "http://localhost:3000";
const EMAIL = process.env.ADMIN_EMAIL;
const PASSWORD = process.env.ADMIN_PASSWORD;

async function readJson(res, label) {
  const text = await res.text();
  if (!res.ok) { console.error(`  ${label}: HTTP ${res.status} body=${text.slice(0, 200)}`); return null; }
  try { return JSON.parse(text); }
  catch { console.error(`  ${label}: non-JSON body=${text.slice(0, 200)}`); return null; }
}

async function main() {
  if (!EMAIL || !PASSWORD) { console.error("ADMIN_EMAIL / ADMIN_PASSWORD not set in env"); process.exit(1); }

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  // node fetch exposes set-cookie via getSetCookie()
  const cookies = typeof login.headers.getSetCookie === "function"
    ? login.headers.getSetCookie()
    : [login.headers.get("set-cookie")].filter(Boolean);
  if (!login.ok || cookies.length === 0) {
    console.error("LOGIN FAILED", login.status, (await login.text()).slice(0, 200));
    process.exit(1);
  }
  const jar = cookies.map(c => c.split(";")[0]).join("; ");
  console.log("logged in OK");

  const views = ["today", "tomorrow", "stuck", "done"];
  let problems = 0;
  for (const v of views) {
    const limit = 500;
    const res = await fetch(`${BASE}/api/tasks?view=${v}&limit=${limit}&sortBy=appointmentTime&sortOrder=asc`, { headers: { Cookie: jar } });
    const data = await readJson(res, `view=${v}`);
    if (!data) { problems++; continue; }
    const tasks = data.tasks || [];
    const total = data.pagination?.total ?? tasks.length;
    const mismatched = tasks.filter(t => t.viewBucket !== v);
    console.log(`\nview=${v}: returned ${tasks.length}, total ${total}`);
    if (mismatched.length) {
      problems++;
      console.log(`  ❌ ${mismatched.length} mismatched (SQL view ≠ computeViewBucket):`);
      for (const t of mismatched.slice(0, 5)) console.log(`     #${t.entityId} appt=${t.appointmentTime} viewBucket=${t.viewBucket}`);
    } else {
      console.log(`  ✓ all ${tasks.length} match viewBucket=${v}`);
    }
    if (total > limit) { problems++; console.log(`  ⚠ CAPPED: ${total} > ${limit} — raise limit or paginate`); }
  }
  console.log(problems === 0 ? "\n✅ ALL BUCKETS CONSISTENT" : `\n❌ ${problems} problem(s)`);
  process.exit(problems === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
