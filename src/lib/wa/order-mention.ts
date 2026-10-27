/**
 * Does a message name an order? (27 Oct 2026: "Kindly update the sample collection
 * status?" reached Star Pathology from the console with no order at all.)
 * An order id (5–6 digits), a lab reference (BLR…, VL…, HYD…, a 7–9 digit booking
 * id) or a 10-digit phone counts; a bare @mention does not.
 */
export function namesAnOrder(text: string | null | undefined): boolean {
  const t = (text ?? "").replace(/[⁨⁩]/g, "");
  if (!t.trim()) return false;
  const withoutMentions = t.replace(/@\d{6,}/g, " ");
  if (/(?<![\d@+])#?\d{5,6}(?![\d])/.test(withoutMentions)) return true;             // order id
  if (/\b[A-Z]{2,5}[0-9A-Z]{5,}\b/.test(withoutMentions)) return true;                 // BLR6372925, VL3D7E71
  if (/\b\d{7,9}\b/.test(withoutMentions)) return true;                                // 19468357 (Redcliffe)
  if (/\d{10}/.test(withoutMentions.replace(/[\s-]/g, ""))) return true;               // a phone
  return false;
}
