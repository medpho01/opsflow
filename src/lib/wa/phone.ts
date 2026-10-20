/**
 * A person's number as WhatsApp addresses it: digits with the country code.
 * "98765 43210", "098765 43210", "+91 98765 43210", "0091…" → "919876543210".
 * A bare 10-digit Indian mobile (starts 6–9) gets 91 — the commonest way a
 * number is typed here, and without it the message silently goes nowhere.
 * Numbers that already carry a country code are left as they are.
 */
export function whatsappDigits(raw: string, defaultCountry = "91"): string {
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 10 && /^[6-9]/.test(digits)) digits = defaultCountry + digits;
  return digits;
}

/** "<digits>@s.whatsapp.net" for a person's number. */
export function personJid(raw: string): string {
  return `${whatsappDigits(raw)}@s.whatsapp.net`;
}
