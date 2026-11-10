/**
 * What labs say about OUR messages (10 Nov 2026). Star asked "Plz send parameters details" on 27,
 * 28 and 29 Oct and Aster "Plz share test code" on 1 Nov; nothing counted it, and the evening list
 * kept going out with bare package names. A lab message is read for order facts only — this reads it
 * for a request to change what we send. Pure and cheap: the daily report scans the stored messages
 * with it, so the count is there from the day the message was sent, not from the day this shipped.
 */
export type FeedbackKind = "test_details" | "patient_details" | "repeats" | "not_ours" | "unclear";

const MISSING_WHAT = /\b(which|what)\b[^.\n]{0,30}\b(tests?|parameters?|reports?)\b[^.\n]{0,25}\b(missing|pending|incorrect|wrong)\b|\bclarify the exact issue\b|\bspecific (error|issue|discrepancy)\b/i;
const RULES: Array<[FeedbackKind, RegExp]> = [
  ["test_details", /\b(send|share|provide|give|mention|need|want|tag|required?)\b[^.\n]{0,40}\b(tests?|parameters?|package|profile)s?\b[^.\n]{0,20}\b(details?|names?|list|codes?|included)\b|\b(tests?|parameters?|package)s?\s+(details?|names?|list|codes?)\s+(not|missing|please|pls|plz|required|needed)|\b(send|share)\b[^.\n]{0,15}\b(parameters?|test codes?)\b|\bfull details\b[^.\n]{0,40}\bparameters?\b/i],
  ["patient_details", /\b(send|share|provide|need|mention|required?)\b[^.\n]{0,40}\b(full|complete|patient|customer|cx|alternate)\b[^.\n]{0,25}\b(details?|address|location|number|age|gender)\b|\b(address|location|pin ?code|contact number|age|gender)\b[^.\n]{0,20}\b(not (mentioned|shared|given|there)|missing|incomplete)\b|\bfull (details|address)\b/i],
  // "Already shared with you", "why asking again" — never "tried the customer multiple times".
  ["repeats", /\balready\b[^.\n]{0,12}\b(told|informed|shared|updated|replied|answered|confirmed)\b[^.\n]{0,40}\b(you|here|mail|group|dashboard|portal|above|check)\b|\b(stop (sending|tagging|messaging)|don'?t (tag|send|message)|why (are you )?(asking|sending) again|same (message|question) again|again and again)\b/i],
  ["not_ours", /\bnot (our|ours)\b|\b(wrong|different) (lab|group|branch)\b|\bnot (belongs?|related) to (us|our)\b|\bthis is not for us\b/i],
  // Our message did not say enough to act on: "which parameter is missing?", "what is this?".
  ["unclear", new RegExp(`${MISSING_WHAT.source}|\\bwhich (order|patient|booking|customer)\\b|\\b(not|didn'?t|did not|unable to) understand\\b|\\bwhat (is this|does this mean)\\b|\\bhow (can|do) (i|we) see\\b`, "i")],
];

/** The kinds of feedback a lab's message carries about our messages; empty for an ordinary reply. */
export function labFeedback(text: string | null | undefined): FeedbackKind[] {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (t.length < 8 || t.length > 600) return [];
  return RULES.filter(([, re]) => re.test(t)).map(([k]) => k);
}

/** The words that made it feedback — the matched phrase only, so a report can quote it without the rest of the message. */
export function feedbackPhrase(text: string | null | undefined): string | null {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  for (const [, re] of RULES) { const m = re.exec(t); if (m) return m[0].slice(0, 80); }
  return null;
}

export const FEEDBACK_LABEL: Record<FeedbackKind, string> = {
  test_details: "asked for the tests or parameters in an order",
  patient_details: "asked for patient or address details",
  repeats: "said we are repeating ourselves or asked us to stop",
  not_ours: "said the order is not theirs",
  unclear: "did not understand our message",
};
