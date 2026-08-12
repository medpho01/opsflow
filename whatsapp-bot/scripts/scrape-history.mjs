#!/usr/bin/env node
/**
 * One-time history scraper — pulls message history for ALL Labstack groups
 * via Baileys' history sync and writes them to out/history.jsonl.
 *
 * Privacy: only groups whose subject matches the Labstack filter are written
 * to disk. Personal groups are dropped before anything is persisted.
 *
 * How it works:
 *   - Connects with syncFullHistory=true.
 *   - Fetches group metadata first (jid -> subject) so we can scope.
 *   - Captures every `messaging-history.set` batch, filters to Labstack groups,
 *     appends {ts, jid, group, sender, text} lines to out/history.jsonl.
 *   - Also captures live messages during the run.
 *   - Detects "done": prints a summary once history stops arriving (idle) and
 *     the latest batch has been seen. Ctrl-C any time — the file is complete
 *     up to that point.
 *
 * Run:  node scripts/scrape-history.mjs
 * A fresh link is needed for a full sync — delete ./auth first if re-scanning.
 */
import "dotenv/config";
import * as baileys from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import pino from "pino";
import fs from "node:fs";
import path from "node:path";
import { isLabstack } from "../lib/classifier.mjs";

const makeWASocket = baileys.makeWASocket || baileys.default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

const GROUP_FILTER = process.env.GROUP_FILTER ?? "labstack";
const GROUP_RE = GROUP_FILTER ? new RegExp(GROUP_FILTER, "i") : null;
const OUT = path.join(process.cwd(), "out");
fs.mkdirSync(OUT, { recursive: true });
const HIST = path.join(OUT, "history.jsonl");
const QRTXT = path.join(process.cwd(), "last-qr.txt");
const logger = pino({ level: "silent" });

const groupSubjects = new Map();
let groupsReady = false;
let groupsReadyResolve;
const groupsReadyP = new Promise((r) => (groupsReadyResolve = r));

const seen = new Set();            // dedupe by jid|msgid
const perGroup = new Map();        // subject -> count
let written = 0, skippedPersonalMsgs = 0, sawLatest = false;
const out = fs.createWriteStream(HIST, { flags: "w" });

function inScope(jid) {
  if (!GROUP_RE) return true;
  const s = groupSubjects.get(jid);
  return s ? GROUP_RE.test(s) : false;
}

function textOf(msg) {
  if (!msg) return "";
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    msg.buttonsResponseMessage?.selectedDisplayText ||
    msg.listResponseMessage?.title ||
    ""
  );
}

async function persist(waMessages, source) {
  await groupsReadyP; // ensure we can scope before writing
  for (const m of waMessages || []) {
    const jid = m.key?.remoteJid || "";
    if (!jid.endsWith("@g.us")) continue;
    const id = `${jid}|${m.key?.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (!inScope(jid)) { skippedPersonalMsgs++; continue; }
    const text = textOf(m.message).trim();
    if (!text) continue;
    const tsSec = Number(m.messageTimestamp?.low ?? m.messageTimestamp ?? 0);
    const subject = groupSubjects.get(jid) || jid;
    out.write(JSON.stringify({
      ts: tsSec ? new Date(tsSec * 1000).toISOString() : "",
      jid, group: subject,
      sender: m.pushName || m.key?.participant || "",
      text, source,
    }) + "\n");
    written++;
    perGroup.set(subject, (perGroup.get(subject) || 0) + 1);
  }
}

// WhatsApp streams history in waves with long pauses. Be patient: only finish
// after the server marks the latest batch, OR after a long quiet period.
const IDLE_MS = Number(process.env.IDLE_MS || 180000);        // 3 min quiet → done
const HARD_CAP_MS = Number(process.env.HARD_CAP_MS || 900000); // 15 min absolute cap
let idleTimer = null, finished = false;
function armIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(finish, IDLE_MS);
}
setTimeout(() => { console.log("(hard cap reached)"); finish(); }, HARD_CAP_MS);
function finish() {
  if (finished) return;
  finished = true;
  if (idleTimer) clearTimeout(idleTimer);
  out.end(() => {
    const groups = [...perGroup.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`\n\x1b[36m── HISTORY SCRAPE COMPLETE ──\x1b[0m`);
    console.log(`Labstack groups with messages: ${groups.length}`);
    console.log(`Messages written: ${written}   (personal msgs skipped: ${skippedPersonalMsgs})`);
    console.log(`sawLatest=${sawLatest}`);
    console.log(`\nTop groups by volume:`);
    for (const [g, n] of groups.slice(0, 25)) console.log(`  ${String(n).padStart(6)}  ${g}`);
    console.log(`\nwrote → ${HIST}`);
    console.log(`next: node scripts/analyze-history.mjs   then  python3 scripts/build_xlsx.py`);
    process.exit(0);
  });
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version, auth: state, logger,
    markOnlineOnConnect: false,
    syncFullHistory: true,
  });
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      console.log("\n\x1b[36mScan to link (Settings → Linked Devices → Link a Device):\x1b[0m");
      qrcode.generate(qr, { small: true });
      try { fs.writeFileSync(QRTXT, qr); } catch {}
    }
    if (connection === "open") {
      console.log(`\x1b[32m✅ Connected as ${sock.user?.id}. Fetching groups…\x1b[0m`);
      try {
        const groups = await sock.groupFetchAllParticipating();
        for (const g of Object.values(groups)) groupSubjects.set(g.id, g.subject);
        const scoped = [...groupSubjects.values()].filter((s) => GROUP_RE?.test(s)).length;
        console.log(`In ${groupSubjects.size} groups · ${scoped} Labstack in scope. Waiting for history sync…`);
      } catch (e) { console.warn("group fetch failed:", e.message); }
      groupsReady = true; groupsReadyResolve();
      armIdle();
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) { console.log("Logged out — delete ./auth and re-scan."); process.exit(1); }
      console.log(`(reconnecting, code ${code})`); start();
    }
  });

  // History sync batches
  sock.ev.on("messaging-history.set", async ({ chats, messages, isLatest, progress, syncType }) => {
    // enrich subjects from chats too (some groups may not be in participating fetch)
    for (const c of chats || []) if (c.id?.endsWith?.("@g.us") && c.name) groupSubjects.set(c.id, c.name);
    await persist(messages, "history");
    console.log(`history batch: +${messages?.length || 0} msgs (written ${written}, progress ${progress ?? "?"}%, latest=${!!isLatest})`);
    if (isLatest) { sawLatest = true; setTimeout(finish, 15000); } // end-of-history → short grace then done
    else armIdle();
  });

  // Live messages during the run
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    await persist(messages, "live");
  });
}

start();
