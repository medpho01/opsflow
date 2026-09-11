export type Mention = { name: string; jid: string; localpart: string };

// The composer shows "@Name" for readability; on send we swap each still-present
// "@Name" for the WhatsApp "@<localpart>" form and collect the jids to notify.
export function applyMentions(text: string, mentions: Mention[]): { text: string; jids: string[] } {
  let out = text;
  const jids: string[] = [];
  for (const m of mentions) {
    const token = `@${m.name}`;
    if (out.includes(token)) {
      out = out.split(token).join(`@${m.localpart}`);
      if (!jids.includes(m.jid)) jids.push(m.jid);
    }
  }
  return { text: out, jids };
}

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
