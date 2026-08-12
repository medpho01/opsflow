#!/usr/bin/env node
/**
 * Push newly-classified live messages into a PRIVATE Google Sheet via the
 * Sheets API. Near-live: run on a timer (launchd/cron every few minutes).
 *
 * Reads dry-run.log.jsonl, transforms each line to the same 16-column schema
 * as the Excel, and APPENDS only rows not yet pushed (tracked by a cursor
 * file). Writes the header row once. No public URL — the sheet stays private,
 * shared only with you + the service account. PII-safe.
 *
 * Config (in .env):
 *   GSHEET_ID=<the id from the sheet URL /d/<ID>/edit>
 *   GOOGLE_APPLICATION_CREDENTIALS=./service-account.json   (path to key)
 *   GSHEET_TAB=Messages            (optional; default "Messages")
 *
 * Setup (one-time, done by you in Google):
 *   1. Google Cloud → new project → enable "Google Sheets API".
 *   2. Create a Service Account → add key → download JSON → save its path above.
 *   3. Create the Google Sheet; Share it with the service account's email
 *      (client_email in the JSON) as Editor.
 *   4. Put GSHEET_ID + GOOGLE_APPLICATION_CREDENTIALS in .env, then run:
 *        node scripts/sync-to-sheets.mjs
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { google } from "googleapis";
import { isLabstack, extractIds } from "../lib/classifier.mjs";
import { PLAYBOOK, confidenceFor } from "../lib/playbook.mjs";

const LOG = path.join(process.cwd(), "dry-run.log.jsonl");
const CURSOR = path.join(process.cwd(), ".sheets-cursor");
const TAB = process.env.GSHEET_TAB || "Messages";
const SHEET_ID = process.env.GSHEET_ID;
const KEY = process.env.GOOGLE_APPLICATION_CREDENTIALS;

const COLUMNS = ["date","time","group","sender","side","message","has_id","ids","intent","disposition","action_type","needs_db_lookup","confidence","phase","owner","bot_action_or_reply"];

function rowFrom(o) {
  const ts = new Date(o.ts);
  const date = isNaN(ts) ? "" : ts.toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata" });
  const time = isNaN(ts) ? "" : ts.toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata" });
  const text = o.text || "";
  const intent = o.intent || "OTHER";
  const pb = PLAYBOOK[intent] || {};
  const { ids, hasId } = extractIds(text);
  const side = isLabstack(o.sender) ? "LAB" : "PARTNER";
  const action = o.willReply ? o.reply : (o.note || pb.summary || "");
  return [
    date, time, o.group || o.jid || "", o.sender || "", side, text,
    hasId ? "Y" : "N", (o.ids || ids).join(" "), intent, o.disposition || pb.disposition || "",
    pb.action || "", pb.lookup ? "Y" : "N", confidenceFor(intent, hasId), pb.phase || "", pb.owner || "", action,
  ];
}

if (!SHEET_ID || !KEY) {
  console.log("sync-to-sheets: not configured (set GSHEET_ID + GOOGLE_APPLICATION_CREDENTIALS in .env) — skipping.");
  process.exit(0);
}
if (!fs.existsSync(KEY)) { console.error(`service-account key not found at ${KEY}`); process.exit(1); }
if (!fs.existsSync(LOG)) { console.log("no dry-run.log.jsonl yet — nothing to sync."); process.exit(0); }

const lines = fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean);
let cursor = 0;
try { cursor = parseInt(fs.readFileSync(CURSOR, "utf8").trim(), 10) || 0; } catch {}
if (cursor > lines.length) cursor = 0; // log was rotated/reset

const auth = new google.auth.GoogleAuth({ keyFile: KEY, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
const sheets = google.sheets({ version: "v4", auth });

// Ensure the tab exists and has a header row (first run only).
async function ensureHeader() {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const has = meta.data.sheets?.some((s) => s.properties?.title === TAB);
  if (!has) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests: [{ addSheet: { properties: { title: TAB } } }] } });
  }
  const head = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${TAB}!A1:P1` });
  if (!head.data.values || head.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${TAB}!A1`, valueInputOption: "RAW",
      requestBody: { values: [COLUMNS] },
    });
    console.log("wrote header row");
  }
}

const fresh = lines.slice(cursor);
if (!fresh.length) { console.log(`up to date (${cursor} rows already synced)`); process.exit(0); }

await ensureHeader();
const rows = fresh.map((l) => { try { return rowFrom(JSON.parse(l)); } catch { return null; } }).filter(Boolean);

// Append in chunks (Sheets API caps request size).
const CHUNK = 500;
for (let i = 0; i < rows.length; i += CHUNK) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID, range: `${TAB}!A1`, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows.slice(i, i + CHUNK) },
  });
}
fs.writeFileSync(CURSOR, String(lines.length));
console.log(`synced ${rows.length} new rows → Google Sheet tab "${TAB}" (cursor ${cursor} → ${lines.length})`);
