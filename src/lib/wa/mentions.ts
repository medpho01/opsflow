// Normalize an inbound `mentions` payload into a clean jid array.
// JSON bodies send an array; multipart form fields send a JSON string. Accept
// both, keep only jid-shaped values (contain "@"), dedupe, and cap the count.
export function normalizeMentions(raw: unknown): string[] {
  let arr: unknown = raw;
  if (typeof raw === "string") {
    try { arr = JSON.parse(raw); } catch { arr = raw.split(","); }
  }
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map((x) => String(x).trim()).filter((s) => s.includes("@")))].slice(0, 20);
}
