/**
 * The portal worker (DESIGN.md §4.12, FR-17): a separate process — the only
 * one holding AGENT_VAULT_PRIVATE_KEY — that keeps a logged-in, read-only
 * browser session per lab portal and reads what the console lacks for the
 * orders journeys ask about. Reads become facts with source "portal".
 *
 *   portal.read    { labId, orderId, labRef, journeyId }  rate-limited per lab
 *   portal.signin  { labId }                              log the session in
 *   portal.health  every 5 min                            detect logouts, alert
 *
 * Run: `npm run portal-worker`. Needs a Chromium: PLAYWRIGHT_CHROMIUM_PATH or
 * `npx playwright install chromium` on the host.
 */
import PgBoss from "pg-boss";
import path from "node:path";
import fs from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import prisma from "@/lib/db/client";
import { readPortalLogin, vaultCanRead } from "@/lib/agents/portal/vault";
import { parsePortalText, portalFieldsToFacts, ADAPTER_PRESETS, type AdapterConfig } from "@/lib/agents/portal/adapters";
import { PORTAL_QUEUES } from "@/lib/agents/queue";
import { recordJourneyEvent } from "@/lib/agents/journey/run";
import { createAgentTask } from "@/lib/agents/executors/tasks";

const STATE_DIR = process.env.PORTAL_STATE_DIR || path.join(process.cwd(), ".portal-state");
const SCREENSHOT_DIR = process.env.PORTAL_SCREENSHOT_DIR || path.join(process.cwd(), ".portal-screenshots");
const MIN_GAP_MS = Number(process.env.PORTAL_MIN_GAP_MS ?? 4000);
const DAILY_READ_CAP = Number(process.env.PORTAL_DAILY_READ_CAP ?? 300);

const contexts = new Map<number, BrowserContext>();
const lastReadAt = new Map<number, number>();

function connectionString(): string { const url = process.env.DATABASE_URL; if (!url) throw new Error("DATABASE_URL is not set"); return url.split("?")[0]; }

async function contextFor(labId: number): Promise<BrowserContext> {
  const existing = contexts.get(labId);
  if (existing) return existing;
  await fs.mkdir(STATE_DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(path.join(STATE_DIR, `lab-${labId}`), { headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined, viewport: { width: 1280, height: 900 } });
  contexts.set(labId, ctx);
  return ctx;
}

function configFor(stored: Record<string, unknown>): AdapterConfig {
  const preset = ADAPTER_PRESETS[String(stored.adapter ?? "generic")] ?? ADAPTER_PRESETS.generic;
  return { ...preset, ...stored } as AdapterConfig;
}

async function setStatus(labId: number, status: string, error?: string | null) {
  await prisma.agentPortalSession.upsert({ where: { labId }, update: { status, lastError: error ?? null, ...(status === "OK" ? { lastOkAt: new Date() } : {}) }, create: { labId, adapter: "generic", status, lastError: error ?? null, lastOkAt: status === "OK" ? new Date() : null } });
}

async function isLoggedIn(page: Page, cfg: AdapterConfig): Promise<boolean> {
  try { return (await page.locator(cfg.loggedInSelector).count()) > 0; } catch { return false; }
}

async function signIn(labId: number): Promise<void> {
  const secret = await readPortalLogin(labId, "signin");
  if (!secret) { await setStatus(labId, "NOT_SET", "no login stored"); return; }
  const cfg = configFor(secret.config);
  if (!cfg.loginUrl || cfg.loginUrl.startsWith("[")) { await setStatus(labId, "ERROR", "adapter not configured: login URL"); return; }
  const ctx = await contextFor(labId);
  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.goto(cfg.loginUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  if (await isLoggedIn(page, cfg)) { await setStatus(labId, "OK"); return; }
  await page.fill(cfg.usernameSelector, secret.login.username);
  await page.fill(cfg.passwordSelector, secret.login.password);
  await page.click(cfg.submitSelector);
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
  if (await isLoggedIn(page, cfg)) { await setStatus(labId, "OK"); return; }
  // An OTP or a changed page: a person signs in from Controls (DESIGN.md §4.12).
  await setStatus(labId, "LOGGED_OUT", "login did not reach the logged-in page (OTP or a changed form?)");
  await signinTask(labId, "The portal login needs a person (OTP or a changed form)");
}

async function signinTask(labId: number, why: string) {
  await createAgentTask({ orderId: 0, orderType: "PORTAL", storeId: null, type: "AGENT_PORTAL_SIGNIN", title: `Sign the lab ${labId} portal back in`, payload: { journeyId: null, cause: "PORTAL_SIGNIN", evidence: [{ kind: "portal", text: why }], action: "Open Controls › Portals and complete the sign-in", labId, verify: { kind: "none" } }, idemKey: `portal-signin:${labId}:${new Date().toDateString()}` }).catch(() => undefined);
}

async function readOrder(job: { labId: number; orderId: number; labRef: string | null; journeyId: string | null }) {
  const { labId, orderId } = job;
  const session = await prisma.agentPortalSession.findUnique({ where: { labId } });
  if (!session || session.status === "NOT_SET") return { skipped: "no session" };
  if (session.readsToday >= DAILY_READ_CAP) return { skipped: "daily cap" };
  const gap = Date.now() - (lastReadAt.get(labId) ?? 0);
  if (gap < MIN_GAP_MS) await new Promise((r) => setTimeout(r, MIN_GAP_MS - gap));
  const secret = await readPortalLogin(labId, `read:${orderId}`);
  if (!secret) return { skipped: "no login" };
  const cfg = configFor(secret.config);
  const ctx = await contextFor(labId);
  const page = ctx.pages()[0] ?? await ctx.newPage();
  try {
    const ref = job.labRef ?? String(orderId);
    if (cfg.orderUrl) await page.goto(cfg.orderUrl.replace("{ref}", encodeURIComponent(ref)), { waitUntil: "domcontentloaded", timeout: 30_000 });
    else if (cfg.searchUrl && cfg.searchSelector) {
      await page.goto(cfg.searchUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.fill(cfg.searchSelector, ref);
      if (cfg.searchSubmitSelector) await page.click(cfg.searchSubmitSelector); else await page.keyboard.press("Enter");
      await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
    } else return { skipped: "adapter has no order page" };
    if (!(await isLoggedIn(page, cfg))) { await setStatus(labId, "LOGGED_OUT", "session expired"); await signinTask(labId, "The portal session expired"); return { skipped: "logged out" }; }
    const text = await page.locator(cfg.detailSelector).first().innerText({ timeout: 10_000 }).catch(() => "");
    if (!text.trim()) { await setStatus(labId, "CHANGED", "detail selector found nothing"); return { skipped: "page changed" }; }
    const fields = parsePortalText(text, cfg.patterns);
    await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
    const shot = path.join(SCREENSHOT_DIR, `${labId}-${orderId}-${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: false }).catch(() => undefined);
    await prisma.agentPortalRead.create({ data: { labId, orderId, labRef: job.labRef, fields: fields as object, screenshotPath: shot } });
    await prisma.agentPortalSession.update({ where: { labId }, data: { status: "OK", lastOkAt: new Date(), lastError: null, readsToday: { increment: 1 } } });
    lastReadAt.set(labId, Date.now());
    const facts = portalFieldsToFacts(fields);
    for (const [i, f] of facts.entries()) {
      await recordJourneyEvent(orderId, { kind: "fact", at: new Date(), actor: "PORTAL", payload: { kind: f.kind, value: f.value, confidence: 0.95, source: "portal", attributedBy: "ORDER_ID", factId: `portal:${orderId}:${Date.now()}:${i}` } }, i === facts.length - 1);
    }
    return { facts: facts.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await setStatus(labId, "ERROR", message.slice(0, 200));
    return { error: message };
  }
}

export async function startPortalWorker(): Promise<PgBoss> {
  if (!vaultCanRead()) throw new Error("The portal worker cannot read logins: set AGENT_VAULT_KEY (shared with the app) or AGENT_VAULT_PRIVATE_KEY");
  const boss = new PgBoss({ connectionString: connectionString(), schema: process.env.PGBOSS_SCHEMA || "pgboss", max: 3 });
  boss.on("error", (error) => console.error("[PortalWorker] pg-boss:", error instanceof Error ? error.message : error));
  await boss.start();
  for (const name of Object.values(PORTAL_QUEUES)) await boss.createQueue(name, { name, policy: "stately", retryLimit: 1, expireInSeconds: 300 }).catch(() => undefined);
  await boss.work<{ labId: number; orderId: number; labRef: string | null; journeyId: string | null }>(PORTAL_QUEUES.read, { batchSize: 1, pollingIntervalSeconds: 2 }, async (jobs) => { for (const j of jobs) console.log(`[PortalWorker] read ${j.data.orderId} @ lab ${j.data.labId}:`, JSON.stringify(await readOrder(j.data))); });
  await boss.work<{ labId: number }>(PORTAL_QUEUES.signin, { batchSize: 1, pollingIntervalSeconds: 2 }, async (jobs) => { for (const j of jobs) { await signIn(j.data.labId); console.log(`[PortalWorker] signin lab ${j.data.labId}`); } });
  await boss.work(PORTAL_QUEUES.health, { batchSize: 1, pollingIntervalSeconds: 10 }, async () => {
    const sessions = await prisma.agentPortalSession.findMany({ where: { status: { in: ["OK", "LOGGED_OUT", "CHANGED", "ERROR"] } } });
    for (const s of sessions) {
      const secret = await readPortalLogin(s.labId, "health").catch(() => null);
      if (!secret) continue;
      const cfg = configFor(secret.config);
      if (!cfg.loginUrl || cfg.loginUrl.startsWith("[")) continue;
      try {
        const ctx = await contextFor(s.labId); const page = ctx.pages()[0] ?? await ctx.newPage();
        await page.goto(cfg.loginUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        const ok = await isLoggedIn(page, cfg);
        if (ok) await setStatus(s.labId, "OK");
        else if (s.status === "OK") { await setStatus(s.labId, "LOGGED_OUT", "health check: not logged in"); await signinTask(s.labId, "The portal session expired"); }
      } catch (error) { await setStatus(s.labId, "ERROR", error instanceof Error ? error.message.slice(0, 200) : String(error)); }
    }
    // Daily read counters reset at midnight local.
    const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: process.env.TIMEZONE || "Asia/Kolkata" }).format(new Date()));
    if (h === 0) await prisma.agentPortalSession.updateMany({ data: { readsToday: 0 } });
  });
  await boss.schedule(PORTAL_QUEUES.health, "*/5 * * * *", {}, { tz: process.env.TIMEZONE || "Asia/Kolkata" });
  console.log("[PortalWorker] started: portal.read, portal.signin, portal.health every 5 min");
  return boss;
}

if (require.main === module) {
  startPortalWorker().then((boss) => {
    const stop = async () => { for (const c of contexts.values()) await c.close().catch(() => undefined); await boss.stop({ graceful: true, timeout: 20_000 }); process.exit(0); };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
  }).catch((error) => { console.error("[PortalWorker] failed to start:", error); process.exit(1); });
}
