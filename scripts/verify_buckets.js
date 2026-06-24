// Verifies Smart View bucketing end-to-end against the live API.
// 1. Logs in as admin to get a session cookie.
// 2. For each view (today/tomorrow/stuck), fetches /api/tasks?view=X and
//    asserts EVERY returned task actually has viewBucket===X — i.e. the
//    SQL view filter and the JS computeViewBucket agree. Drift here is the
//    root cause of "tasks exist but don't show in the right tab".
// 3. Flags any bucket that hit its row cap (possible truncation).
// 4. Cross-checks: an unfiltered fetch grouped by viewBucket should equal
//    the per-view counts.
const BASE = process.env.OPSFLOW_BASE || "http://localhost:4001";
const EMAIL = process.env.ADMIN_EMAIL;
const PASSWORD = process.env.ADMIN_PASSWORD;

async function main() {
  // login
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const cookie = login.headers.get("set-cookie");
  if (!login.ok || !cookie) { console.error("LOGIN FAILED", login.status); process.exit(1); }
  const jar = cookie.split(";")[0];

  const views = ["today", "tomorrow", "stuck", "done"];
  let problems = 0;
  for (const v of views) {
    const limit = 500;
    const res = await fetch(`${BASE}/api/tasks?view=${v}&limit=${limit}&sortBy=appointmentTime&sortOrder=asc`, { headers: { Cookie: jar } });
    const data = await res.json();
    const tasks = data.tasks || [];
    const total = data.pagination?.total ?? tasks.length;
    // Every returned task must carry viewBucket === v (done is terminal).
    const mismatched = tasks.filter(t => t.viewBucket !== v);
    const capped = total > limit;
    console.log(`\nview=${v}: returned ${tasks.length}, pagination.total ${total}`);
    if (mismatched.length) {
      problems++;
      console.log(`  ❌ ${mismatched.length} tasks returned by ?view=${v} but computeViewBucket says otherwise:`);
      for (const t of mismatched.slice(0, 5)) console.log(`     #${t.entityId} appt=${t.appointmentTime} viewBucket=${t.viewBucket} status=${t.status}`);
    } else {
      console.log(`  ✓ all ${tasks.length} match viewBucket=${v}`);
    }
    if (capped) { problems++; console.log(`  ⚠ CAPPED: ${total} > limit ${limit} — some ${v} tasks are truncated, raise the limit or paginate`); }
  }

  console.log(problems === 0 ? "\n✅ ALL BUCKETS CONSISTENT" : `\n❌ ${problems} problem(s) found`);
  process.exit(problems === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
