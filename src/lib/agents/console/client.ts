/**
 * The console write API (DESIGN.md §10): /agent/v1, service account, every
 * write idempotent. Present only when CONSOLE_API_BASE and CONSOLE_API_KEY
 * are set; otherwise `consoleClient()` is null and writes become tasks.
 * Errors never fall back to driving the console UI.
 */
export type ConsoleEvidence = { kind: string; ref: string | null; at: string; text: string };
export type StatusUpdate = { to: string; idempotencyKey: string; evidence: ConsoleEvidence; sopVersion: string | null; note: string };

export type ConsoleClient = {
  updateStatus(orderId: number, body: StatusUpdate): Promise<unknown>;
  appendNote(orderId: number, text: string, idempotencyKey: string): Promise<unknown>;
  refreshOrder(orderId: number, idempotencyKey: string): Promise<unknown>;
};

export function consoleClient(): ConsoleClient | null {
  const base = process.env.CONSOLE_API_BASE;
  const key = process.env.CONSOLE_API_KEY;
  if (!base || !key) return null;
  const call = async (path: string, body: unknown, idempotencyKey: string) => {
    const response = await fetch(`${base.replace(/\/$/, "")}/agent/v1${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "idempotency-key": idempotencyKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`console ${response.status}: ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return { raw: text }; }
  };
  return {
    updateStatus: (orderId, body) => call(`/orders/${orderId}/status`, body, body.idempotencyKey),
    appendNote: (orderId, text, idempotencyKey) => call(`/orders/${orderId}/notes`, { text, idempotencyKey }, idempotencyKey),
    refreshOrder: (orderId, idempotencyKey) => call(`/orders/${orderId}/refresh`, { idempotencyKey }, idempotencyKey),
  };
}
