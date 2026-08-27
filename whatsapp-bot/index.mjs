/**
 * LabStack WhatsApp ops bot — DRY-RUN skeleton.
 *
 * Connects to WhatsApp as a linked device (Baileys), reads group messages,
 * classifies each, looks up the live order/request status, and LOGS what it
 * WOULD reply — sending NOTHING. This lets you validate the bot's answers
 * against real traffic with zero risk of a wrong auto-reply.
 *
 * Flip to live sending only after the dry-run log looks correct AND the
 * account is a dedicated number (see README). Sending is intentionally not
 * implemented in this file yet.
 *
 * Run:  node index.mjs      (first run prints a QR — scan from WhatsApp →
 *                            Linked Devices → Link a Device)
 */
import "dotenv/config";
import * as baileys from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import pino from "pino";
import fs from "node:fs";
import { classify, extractIds, DISPOSITION, isLabstack } from "./lib/classifier.mjs";
import { lookupIds } from "./lib/lookup.mjs";
import { compose } from "./lib/reply.mjs";
import * as CT from "./lib/controltower.mjs";
import * as Analyst from "./lib/analyst.mjs";

// Control Tower integration is active only when the taskos DB is configured.
const CT_ENABLED = !!process.env.TASKOS_DATABASE_URL;
// Case analyst (LLM). Runs only when an Anthropic key is present.
const ANALYST_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANALYST_MODEL = process.env.WA_ANALYST_MODEL || "claude-sonnet-5";
const ANALYST_ENABLED = CT_ENABLED && !!ANALYST_API_KEY && process.env.WA_ANALYST !== "false";
let currentSock = null;   // updated each (re)connect so loops use the live socket
let loopsStarted = false;

// Baileys exposes these as top-level named exports; the default export is
// makeWASocket itself, so we pull everything off the namespace.
const makeWASocket = baileys.makeWASocket || baileys.default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

const DRY_RUN = process.env.DRY_RUN !== "false"; // default TRUE — safe
const LOG_FILE = process.env.LOG_FILE || "./dry-run.log.jsonl";
const BACKFILL_DAYS = Number(process.env.BACKFILL_DAYS || 3); // history window
const logger = pino({ level: "silent" });

// ── Group scoping ─────────────────────────────────────────────────────────
// Only groups whose SUBJECT matches GROUP_FILTER (a case-insensitive regex)
// are observed — everything else (personal groups) is skipped entirely: not
// classified, not logged. Default scopes to Labstack partner-ops groups, and
// auto-includes any new Labstack group without editing a static list.
// GROUP_ALLOW is an optional comma-separated list of extra jids to force-in
// (for ops groups that don't carry "labstack" in the name).
// Set GROUP_FILTER="" AND GROUP_ALLOW="" to observe everything again.
const GROUP_FILTER = process.env.GROUP_FILTER ?? "labstack";
const GROUP_RE = GROUP_FILTER ? new RegExp(GROUP_FILTER, "i") : null;
const GROUP_ALLOW = new Set(
  (process.env.GROUP_ALLOW || "").split(",").map((s) => s.trim()).filter(Boolean)
);
// jid → subject, populated on connect and kept fresh as groups change.
const groupSubjects = new Map();

function inScope(jid) {
  if (!GROUP_RE && GROUP_ALLOW.size === 0) return true; // no filter → observe all
  if (GROUP_ALLOW.has(jid)) return true;
  const subject = groupSubjects.get(jid);
  if (!subject) return false;            // unknown group → out of scope until named
  return GROUP_RE ? GROUP_RE.test(subject) : false;
}

function logLine(obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
  fs.appendFileSync(LOG_FILE, line + "\n");
}
// Full transcript — EVERY in-scope message (partner questions, team replies
// incl. our own sends, acks). This is the ground-truth for learning how the
// team actually handles messages. Separate from the decision log.
const RAW_LOG = process.env.RAW_LOG || "./messages.log.jsonl";
function rawLine(obj) {
  fs.appendFileSync(RAW_LOG, JSON.stringify(obj) + "\n");
}
function banner(s) { console.log(`\n\x1b[36m${s}\x1b[0m`); }

// Crash-proof reconnect: single-flight, exponential backoff. Baileys surfaces
// transient WebSocket failures (1006, 408, 428) as promise rejections — without
// this the process would exit on the first blip.
let reconnecting = false;
let backoff = 2000;
function reconnect() {
  if (reconnecting) return;
  reconnecting = true;
  const delay = backoff;
  backoff = Math.min(backoff * 2, 60000); // cap at 60s
  console.log(`(reconnecting in ${Math.round(delay / 1000)}s)`);
  setTimeout(() => {
    reconnecting = false;
    start().catch((e) => { console.error("reconnect failed:", e?.message || e); reconnect(); });
  }, delay);
}

// Never let a stray socket rejection take the whole process down.
process.on("unhandledRejection", (r) => console.error("unhandledRejection:", r?.message || r));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e?.message || e));

// Background loops (started once): drain the outbound send queue, obey admin
// commands (RELINK/LOGOUT) from the console, heartbeat, and refresh group config.
function startLoops() {
  if (loopsStarted || !CT_ENABLED) return;
  loopsStarted = true;

  const send = async (jid, text, { quoted = null, media = null, mentions = null } = {}) => {
    if (!currentSock) throw new Error("gateway not connected");
    // `quoted` threads the reply under the original; `media` attaches a file;
    // `mentions` is an array of jids to @-notify (text carries "@<localpart>").
    let content;
    if (media && media.bytes) {
      const caption = text || undefined;
      content = (media.mime || "").startsWith("image/")
        ? { image: media.bytes, caption, mimetype: media.mime }
        : { document: media.bytes, fileName: media.name || "file", mimetype: media.mime || "application/octet-stream", caption };
    } else {
      content = { text };
    }
    if (mentions && mentions.length) content.mentions = mentions;
    const r = await currentSock.sendMessage(jid, content, quoted ? { quoted } : {});
    await new Promise((res) => setTimeout(res, 1200)); // human-paced spacing
    return r?.key?.id;
  };

  setInterval(async () => {
    if (DRY_RUN) return; // master kill switch — nothing sends while DRY_RUN
    try { await CT.drainOutbound(send); } catch (e) { console.error("drain:", e.message); }
  }, 4000);

  setInterval(async () => {
    try {
      const cmd = await CT.consumeCommand();
      if (cmd === "LOGOUT" || cmd === "RELINK") {
        console.log(`admin command: ${cmd}`);
        try { await currentSock?.logout(); } catch {}
        try { fs.rmSync("./auth", { recursive: true, force: true }); } catch {}
        reconnect();
      } else if (cmd === "BACKFILL") {
        // Re-resolve threads/ids for the recent window right away (reliable),
        // then ask WhatsApp for a fresh recent-history sync so the
        // messaging-history.set handler can backfill any missed media.
        console.log(`admin command: BACKFILL (${BACKFILL_DAYS}d)`);
        try {
          const res = await CT.reresolveWindow({ days: BACKFILL_DAYS });
          console.log(`backfill re-resolve: ${JSON.stringify(res)}`);
        } catch (e) { console.error("backfill resolve:", e.message); }
        try {
          const rr = await CT.backfillResponses();
          console.log(`backfill responses: ${JSON.stringify(rr)}`);
        } catch (e) { console.error("backfill responses:", e.message); }
        try {
          const pc = await CT.backfillProviderCases({ days: BACKFILL_DAYS });
          console.log(`backfill provider cases: ${JSON.stringify(pc)}`);
        } catch (e) { console.error("backfill provider cases:", e.message); }
        try {
          const lm = await CT.mapLabGroups();
          console.log(`lab-group mapping: ${JSON.stringify(lm)}`);
        } catch (e) { console.error("lab-group mapping:", e.message); }
        try {
          if (typeof currentSock?.fetchMessageHistory === "function") {
            // Anchor at the newest message per active group and pull a page of
            // recent history; results arrive via messaging-history.set.
            const anchors = await CT.newestPerActiveGroup();
            for (const a of anchors) {
              if (!a.waMsgId) continue;
              try {
                await currentSock.fetchMessageHistory(
                  50,
                  { remoteJid: a.jid, id: a.waMsgId, fromMe: a.fromMe },
                  Math.floor(new Date(a.ts).getTime() / 1000)
                );
              } catch { /* per-group best-effort */ }
            }
            console.log(`backfill: requested history for ${anchors.length} groups`);
          }
        } catch (e) { console.error("backfill history:", e.message); }
      }
    } catch {}
  }, 5000);

  setInterval(() => CT.heartbeat(DRY_RUN).catch(() => {}), 20000);
  setInterval(() => CT.refreshGroups().catch(() => {}), 30000);

  // Case analyst: continuously (but change-detected) synthesize an LLM brief
  // per active order — status, timeline, resolution, in-context suggestions.
  if (ANALYST_ENABLED) {
    console.log(`case analyst ON (model=${ANALYST_MODEL})`);
    setInterval(() => {
      Analyst.analyzeActiveCases({ limit: 8, model: ANALYST_MODEL, apiKey: ANALYST_API_KEY })
        .then((r) => { if (r?.analyzed) console.log(`analyst: ${r.analyzed}/${r.candidates} cases`); })
        .catch((e) => console.error("analyst loop:", e.message));
    }, 30000);
  }

  // Groups can be empty right after a FRESH link (the phone hasn't pushed group
  // metadata to the new device yet), so the one-shot discovery on "open" may
  // register nothing. Re-discover shortly after connect and then periodically,
  // so the console fills in on its own — no manual restart needed.
  const discoverAndSync = async () => {
    if (!currentSock || !CT_ENABLED) return;
    try {
      const groups = await currentSock.groupFetchAllParticipating();
      for (const g of Object.values(groups)) groupSubjects.set(g.id, g.subject);
      const all = Object.values(groups).map((g) => [g.id, g.subject]);
      // Register every group; pre-activate only the ones matching the listen hint.
      const preActive = all.filter(([jid, subject]) => GROUP_ALLOW.has(jid) || (GROUP_RE ? GROUP_RE.test(subject || "") : false)).map(([jid]) => jid);
      if (all.length) { await CT.syncGroups(all, preActive); console.log(`registered ${all.length} groups (${preActive.length} pre-activated) in the console`); }
    } catch (e) { console.error("group discovery:", e.message); }
  };
  setTimeout(discoverAndSync, 15000);    // catch the fresh-link case quickly
  setInterval(discoverAndSync, 120000);  // and keep it current every 2 min
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({ version, auth: state, logger, markOnlineOnConnect: false });
  currentSock = sock;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      banner("Scan this QR from WhatsApp → Settings → Linked Devices → Link a Device:");
      qrcode.generate(qr, { small: true });
      // Also persist the raw payload so it can be rendered as a crisp PNG.
      try { fs.writeFileSync("./last-qr.txt", qr); } catch {}
      if (CT_ENABLED) CT.setQr(qr).catch((e) => console.error("CT setQr:", e.message));
    }
    if (connection === "open") {
      backoff = 2000; // healthy again — reset reconnect backoff
      banner(`✅ Connected as ${sock.user?.id || "?"} — DRY_RUN=${DRY_RUN}`);
      if (CT_ENABLED) {
        try {
          await CT.refreshGroups();
          const num = String(sock.user?.id || "").split(/[:@]/)[0];
          await CT.setConnected(num);
        } catch (e) { console.error("CT connect:", e.message); }
        startLoops();
      }
      // Discover groups so you can label them partner vs lab in config.
      try {
        const groups = await sock.groupFetchAllParticipating();
        for (const g of Object.values(groups)) groupSubjects.set(g.id, g.subject);
        const all = [...groupSubjects.entries()];
        const preActive = all.filter(([jid, subject]) => GROUP_ALLOW.has(jid) || (GROUP_RE ? GROUP_RE.test(subject || "") : false)).map(([jid]) => jid);
        banner(`In ${groupSubjects.size} groups · ${preActive.length} match the listen hint (/${GROUP_FILTER}/i) — pick which to listen to in Settings:`);
        for (const [jid, subject] of all) console.log(`  ${preActive.includes(jid) ? "•" : " "} ${jid}   ${subject}`);
        console.log("");
        // Register EVERY group in the console so the admin sees the full roster
        // and picks which to listen to. New groups land inactive; the ones that
        // match the hint are pre-activated for a turnkey first run.
        if (CT_ENABLED) await CT.syncGroups(all, preActive);
      } catch (e) { console.warn("Could not fetch groups:", e.message); }
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      banner(`Connection closed (code ${code}). ${loggedOut ? "Logged out — delete ./auth and re-scan." : "Reconnecting…"}`);
      if (CT_ENABLED) CT.setStatus(loggedOut ? "LOGGED_OUT" : "CONNECTING").catch(() => {});
      if (!loggedOut) reconnect();
    }
  });

  // Keep subjects fresh as groups are created / renamed.
  sock.ev.on("groups.upsert", (gs) => { for (const g of gs) groupSubjects.set(g.id, g.subject); });
  sock.ev.on("groups.update", (gs) => { for (const g of gs) if (g.id && g.subject) groupSubjects.set(g.id, g.subject); });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      try { await handle(m); } catch (e) { console.error("handle error:", e.message); }
    }
  });

  // Historical messages WhatsApp pushes on (re)connect, or in response to a
  // fetchMessageHistory request. Processing them through the SAME pipeline is
  // idempotent and backfills anything we missed while offline or before media
  // capture — including image bytes, as long as WhatsApp still serves them.
  sock.ev.on("messaging-history.set", async ({ messages }) => {
    if (!messages?.length) return;
    const cutoff = Math.floor(Date.now() / 1000) - BACKFILL_DAYS * 86400;
    let done = 0;
    for (const m of messages) {
      const ts = Number(m.messageTimestamp?.low ?? m.messageTimestamp ?? 0);
      if (ts && ts < cutoff) continue; // keep to the recent window
      try { await handle(m); done++; } catch { /* best-effort */ }
    }
    if (done) console.log(`history sync: processed ${done}/${messages.length} recent messages`);
  });
}

function contentOf(msg = {}) {
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    ""
  );
}
function extractText(m) { return contentOf(m.message || {}); }

// Identify an attachment on the message (image/document/video/audio/sticker).
// Returns { kind, mime, filename } or null. WhatsApp wraps some media in
// viewOnce/ephemeral envelopes, so we unwrap those first.
function mediaInfo(m) {
  let msg = m.message || {};
  msg = msg.ephemeralMessage?.message || msg.viewOnceMessage?.message || msg.viewOnceMessageV2?.message || msg;
  if (msg.imageMessage) return { kind: "image", mime: msg.imageMessage.mimetype || "image/jpeg", filename: null };
  if (msg.documentMessage) return { kind: "document", mime: msg.documentMessage.mimetype || "application/octet-stream", filename: msg.documentMessage.fileName || null };
  if (msg.documentWithCaptionMessage?.message?.documentMessage) {
    const d = msg.documentWithCaptionMessage.message.documentMessage;
    return { kind: "document", mime: d.mimetype || "application/octet-stream", filename: d.fileName || null };
  }
  if (msg.stickerMessage) return { kind: "sticker", mime: msg.stickerMessage.mimetype || "image/webp", filename: null };
  if (msg.videoMessage) return { kind: "video", mime: msg.videoMessage.mimetype || "video/mp4", filename: null };
  return null;
}

const MAX_MEDIA_BYTES = 12 * 1024 * 1024; // don't pull huge files into the gateway
async function downloadMedia(m) {
  try {
    const buf = await baileys.downloadMediaMessage(
      m, "buffer", {},
      { reuploadRequest: currentSock?.updateMediaMessage?.bind(currentSock) }
    );
    if (!buf || buf.length === 0 || buf.length > MAX_MEDIA_BYTES) return null;
    return buf;
  } catch (e) {
    console.error("media download:", e.message);
    return null;
  }
}

// Pull the quoted/replied-to message (WhatsApp "reply") for direct Q→A linking.
// contextInfo can hang off ANY message type (text, image, document…), so we
// look across them — a reply on a photo must keep the chain too.
function replyContext(m) {
  let msg = m.message || {};
  msg = msg.ephemeralMessage?.message || msg.viewOnceMessage?.message || msg.viewOnceMessageV2?.message || msg;
  const ci =
    msg.extendedTextMessage?.contextInfo ||
    msg.imageMessage?.contextInfo ||
    msg.videoMessage?.contextInfo ||
    msg.documentMessage?.contextInfo ||
    msg.documentWithCaptionMessage?.message?.documentMessage?.contextInfo ||
    msg.stickerMessage?.contextInfo ||
    msg.audioMessage?.contextInfo;
  if (!ci?.stanzaId) return null;
  return {
    replyToId: ci.stanzaId,
    replyToAuthor: ci.participant || "",
    replyToText: contentOf(ci.quotedMessage || {}).replace(/\s+/g, " ").slice(0, 300),
  };
}

async function handle(m) {
  const jid = m.key.remoteJid || "";
  if (!jid.endsWith("@g.us")) return; // groups only
  // Listen only to groups the admin picked (active). Discovery registers EVERY
  // group so they can be chosen in Settings; until a group is activated we don't
  // process it (no media pulled, nothing stored). Falls back to the env hint
  // when the console DB isn't wired up (pure dry-run).
  if (CT_ENABLED) {
    const g = CT.getGroup(jid);
    if (!g || !g.active) return;
  } else if (!inScope(jid)) return;

  const text = extractText(m).trim();
  const media = mediaInfo(m);
  if (!text && !media) return; // pure system/empty event — nothing to capture
  const fromMe = !!m.key.fromMe;
  const sender = fromMe ? "me (LabStack)" : (m.pushName || m.key.participant || "");
  const side = fromMe || isLabstack(sender) ? "LAB" : "PARTNER";
  const rc = replyContext(m);

  // ── FULL TRANSCRIPT: log EVERY message, including our own team replies and
  // acks. This is what we learn "how it's handled" from. ──────────────────
  const { ids: rawIds } = extractIds(text);
  rawLine({
    ts: new Date().toISOString(), jid, group: groupSubjects.get(jid) || "",
    msgId: m.key.id, fromMe, side, sender, text,
    ids: rawIds, intent: classify(text, sender),
    ...(rc || {}),
  });

  // ── CONTROL TOWER: persist to the taskos DB (messages + tickets) ─────────
  if (CT_ENABLED) {
    const tsSec = Number(m.messageTimestamp?.low ?? m.messageTimestamp ?? 0) || Math.floor(Date.now() / 1000);
    // Pull the actual bytes for image/document media so the console can show
    // and interpret it — a caption-less report screenshot is otherwise blind.
    let mediaBytes = null;
    if (media && (media.kind === "image" || media.kind === "document")) {
      mediaBytes = await downloadMedia(m);
    }
    try {
      await CT.ingestMessage({
        jid, waMsgId: m.key.id, fromMe, sender, senderJid: m.key.participant || null, text,
        ts: new Date(tsSec * 1000), replyToWaId: rc?.replyToId || null,
        mediaKind: media?.kind || null, mediaMime: media?.mime || null,
        mediaFilename: media?.filename || null, mediaBytes,
      });
    } catch (e) { console.error("CT ingest:", e.message); }
  }

  // ── DECISION LOGIC (dry-run): only for inbound partner messages ──────────
  if (fromMe) return;                 // don't auto-act on our own posts

  const intent = classify(text, sender);
  const disposition = DISPOSITION[intent];
  if (disposition === "NOISE") return; // don't log chatter

  const { ids } = extractIds(text);
  const lookup = disposition === "AUTO_ANSWER" ? await lookupIds(ids) : { orders: [], requests: [] };
  const { willReply, text: replyText, note } = compose({ intent, disposition, lookup });

  // Console view — human-readable
  const tag = willReply ? "\x1b[32mWOULD REPLY\x1b[0m" : "\x1b[33m" + disposition + "\x1b[0m";
  console.log(`[${tag}] (${intent}) ${sender}: ${text.replace(/\n/g, " ⏎ ").slice(0, 90)}`);
  if (willReply) console.log(`      ↳ ${replyText.replace(/\n/g, "\n        ")}`);
  else console.log(`      ↳ ${note}`);

  // Structured log — for measuring accuracy over the trial
  logLine({ jid, group: groupSubjects.get(jid) || "", sender, text, intent, disposition, ids, willReply, reply: replyText, note });

  // ── SENDING IS DISABLED IN DRY-RUN ──────────────────────────────────────
  // When you go live (dedicated number + validated log), this is where a
  // guarded sock.sendMessage(jid, { text: replyText }, { quoted: m }) goes,
  // gated on DRY_RUN === false and per-group opt-in.
}

start().catch((e) => { console.error("fatal:", e); process.exit(1); });
