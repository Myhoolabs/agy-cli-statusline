// SPDX-License-Identifier: MIT
// Read-only Antigravity CLI session DB & path resolver (zero external dependencies).
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const STEP_TYPE_USER_INPUT = 14;
const STEP_TYPE_PLANNER_RESPONSE = 15;
const STEP_STATUS_DONE = 3;

let cachedSqlite = undefined;
function getDatabaseSync() {
  if (cachedSqlite !== undefined) return cachedSqlite;
  try {
    const mod = require("node:sqlite");
    cachedSqlite = typeof mod?.DatabaseSync === "function" ? mod.DatabaseSync : null;
  } catch {
    cachedSqlite = null;
  }
  return cachedSqlite;
}

function fileExists(filePath) {
  if (!filePath || typeof filePath !== "string") return false;
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function extractConversationId(payload) {
  const candidates = [
    payload?.transcript_path,
    payload?.conversation_id,
    payload?.session_id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate) continue;
    const match = candidate.match(UUID_RE);
    if (match) return match[0].toLowerCase();
  }
  return null;
}

function defaultCliDataDir() {
  return path.join(os.homedir(), ".gemini", "antigravity-cli");
}

function inferCliDataDir(transcriptPath) {
  if (typeof transcriptPath === "string" && transcriptPath) {
    const normalized = transcriptPath.replace(/\//g, path.sep);
    const marker = `${path.sep}brain${path.sep}`;
    const idx = normalized.toLowerCase().lastIndexOf(marker);
    if (idx > 0) {
      const candidate = normalized.slice(0, idx);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return defaultCliDataDir();
}

function resolveSessionFiles(payload) {
  const rawTranscript = typeof payload?.transcript_path === "string" ? payload.transcript_path : "";
  const conversationId = extractConversationId(payload);

  let transcriptPath = null;
  if (fileExists(rawTranscript)) {
    transcriptPath = rawTranscript;
  } else if (rawTranscript && /[\\/]\.gemini[\\/]antigravity[\\/]/i.test(rawTranscript)) {
    // Work around Antigravity CLI emitting ~/.gemini/antigravity/... instead of antigravity-cli/...
    const corrected = rawTranscript.replace(
      /([\\/]\.gemini[\\/])antigravity([\\/])/i,
      "$1antigravity-cli$2"
    );
    if (fileExists(corrected)) {
      transcriptPath = corrected;
    }
  }

  if (!transcriptPath && conversationId) {
    const fallbackTranscript = path.join(
      defaultCliDataDir(),
      "brain",
      conversationId,
      ".system_generated",
      "logs",
      "transcript.jsonl"
    );
    if (fileExists(fallbackTranscript)) {
      transcriptPath = fallbackTranscript;
    }
  }

  let dbPath = null;
  if (conversationId) {
    const dataDirs = [inferCliDataDir(transcriptPath), defaultCliDataDir()];
    const seen = new Set();
    for (const dir of dataDirs) {
      if (!dir || seen.has(dir)) continue;
      seen.add(dir);
      const candidate = path.join(dir, "conversations", `${conversationId}.db`);
      if (fileExists(candidate)) {
        dbPath = candidate;
        break;
      }
    }
  }

  return {
    conversationId,
    rawTranscriptPath: rawTranscript || null,
    transcriptPath: transcriptPath || (rawTranscript || null),
    transcriptExists: Boolean(transcriptPath),
    dbPath,
  };
}

// --- Minimal safe protobuf wire decoder (no 32-bit bitwise truncation) ---

function readVarint(buf, offset) {
  let val = 0;
  let mult = 1;
  let i = offset;
  const len = buf.length;
  while (i < len && i - offset < 10) {
    const b = buf[i++];
    val += (b & 0x7f) * mult;
    if ((b & 0x80) === 0) {
      return { val, next: i };
    }
    mult *= 128;
  }
  return null;
}

function decodeMessage(buf) {
  const fields = new Map();
  if (!buf || typeof buf.length !== "number") return fields;
  const bytes = buf instanceof Uint8Array ? buf : Buffer.from(buf);
  let i = 0;
  const len = bytes.length;

  while (i < len) {
    const tag = readVarint(bytes, i);
    if (!tag) break;
    i = tag.next;
    const fieldNum = Math.floor(tag.val / 8);
    const wireType = tag.val % 8;
    if (fieldNum <= 0) break;

    let value;
    if (wireType === 0) {
      const v = readVarint(bytes, i);
      if (!v) break;
      value = v.val;
      i = v.next;
    } else if (wireType === 2) {
      const size = readVarint(bytes, i);
      if (!size || size.val < 0 || size.next + size.val > len) break;
      value = bytes.subarray(size.next, size.next + size.val);
      i = size.next + size.val;
    } else if (wireType === 1) {
      if (i + 8 > len) break;
      value = bytes.subarray(i, i + 8);
      i += 8;
    } else if (wireType === 5) {
      if (i + 4 > len) break;
      value = bytes.subarray(i, i + 4);
      i += 4;
    } else {
      break;
    }

    let list = fields.get(fieldNum);
    if (!list) {
      list = [];
      fields.set(fieldNum, list);
    }
    list.push(value);
  }
  return fields;
}

function firstInt(fields, num) {
  const list = fields.get(num);
  if (!list || list.length === 0) return null;
  const v = list[0];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function firstBytes(fields, num) {
  const list = fields.get(num);
  if (!list || list.length === 0) return null;
  const v = list[0];
  return v instanceof Uint8Array ? v : null;
}

function firstText(fields, num) {
  const b = firstBytes(fields, num);
  if (!b || b.length === 0) return "";
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("utf8");
}

function parseTimestampMs(fields, num) {
  const b = firstBytes(fields, num);
  if (!b) return null;
  const ts = decodeMessage(b);
  const sec = firstInt(ts, 1);
  if (!sec || sec < 1_000_000_000) return null;
  const nanos = firstInt(ts, 2) || 0;
  return sec * 1000 + Math.floor(nanos / 1e6);
}

function parseUsageBlob(buf) {
  if (!buf) return null;
  const u = decodeMessage(buf);
  const uncachedInput = firstInt(u, 2) || 0;
  const output = firstInt(u, 3) || 0;
  const cacheRead = firstInt(u, 5) || 0;
  const responseId = firstText(u, 11) || firstText(u, 12) || firstText(u, 7) || "";
  if (uncachedInput === 0 && output === 0 && cacheRead === 0 && !responseId) {
    return null;
  }
  return { uncachedInput, output, cacheRead, responseId };
}

function extractStepUsages(metaFields) {
  const out = [];
  const main = parseUsageBlob(firstBytes(metaFields, 9));
  if (main) out.push(main);
  const retries = metaFields.get(28);
  if (retries) {
    for (const r of retries) {
      if (!(r instanceof Uint8Array)) continue;
      const rm = decodeMessage(r);
      const ru = parseUsageBlob(firstBytes(rm, 2));
      if (ru) out.push(ru);
    }
  }
  return out;
}

function plannerHasToolCalls(payloadBlob) {
  if (!payloadBlob) return false;
  const pm = decodeMessage(payloadBlob);
  const p20Blob = firstBytes(pm, 20);
  if (!p20Blob) return false;
  const p20 = decodeMessage(p20Blob);
  const toolCalls = p20.get(7);
  return Boolean(toolCalls && toolCalls.length > 0);
}

function readSessionDbMetrics(dbPath) {
  if (!dbPath || !fileExists(dbPath)) return null;
  const DatabaseSync = getDatabaseSync();
  if (!DatabaseSync) return null;

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 250 });

    const stepRows = db
      .prepare("SELECT idx, step_type, status, metadata, step_payload FROM steps ORDER BY idx")
      .all();

    const seenUsageIds = new Set();
    let totalCalls = 0;
    let totalUncachedInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;

    let prevTurn = null;
    let currentTurn = null;

    for (const row of stepRows) {
      const idx = Number(row.idx);
      const stepType = Number(row.step_type);
      const status = Number(row.status);
      const metaFields = row.metadata ? decodeMessage(row.metadata) : null;
      const startMs = metaFields ? parseTimestampMs(metaFields, 1) : null;
      const endMs = metaFields ? parseTimestampMs(metaFields, 8) : null;

      if (stepType === STEP_TYPE_USER_INPUT) {
        if (currentTurn) {
          prevTurn = currentTurn;
        }
        currentTurn = {
          userStepIdx: idx,
          userMs: startMs,
          calls: 0,
          uncachedInput: 0,
          cacheRead: 0,
          output: 0,
          lastStepIdx: idx,
          lastStepType: stepType,
          lastStepStatus: status,
          lastStepStartMs: startMs,
          lastStepEndMs: endMs,
          lastPlannerHasToolCalls: false,
        };
      } else if (currentTurn) {
        currentTurn.lastStepIdx = idx;
        currentTurn.lastStepType = stepType;
        currentTurn.lastStepStatus = status;
        currentTurn.lastStepStartMs = startMs;
        currentTurn.lastStepEndMs = endMs;
        currentTurn.lastPlannerHasToolCalls =
          stepType === STEP_TYPE_PLANNER_RESPONSE
            ? plannerHasToolCalls(row.step_payload)
            : false;
      }

      if (metaFields) {
        const usages = extractStepUsages(metaFields);
        for (const u of usages) {
          if (u.responseId) {
            if (seenUsageIds.has(u.responseId)) continue;
            seenUsageIds.add(u.responseId);
          }
          totalCalls += 1;
          totalUncachedInput += u.uncachedInput;
          totalOutput += u.output;
          totalCacheRead += u.cacheRead;
          if (currentTurn) {
            currentTurn.calls += 1;
            currentTurn.uncachedInput += u.uncachedInput;
            currentTurn.cacheRead += u.cacheRead;
            currentTurn.output += u.output;
          }
        }
      }
    }

    // Latest generation_info holds Antigravity's effective context estimate & model cap (e.g. 512000 / 256000).
    let ctxEst = null;
    let ctxCap = null;
    try {
      const latestGen = db
        .prepare("SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 1")
        .get();
      if (latestGen?.data) {
        const gm = decodeMessage(latestGen.data);
        const chatBlob = firstBytes(gm, 1);
        if (chatBlob) {
          const chat = decodeMessage(chatBlob);
          const genInfoBlob = firstBytes(chat, 9);
          if (genInfoBlob) {
            const genInfo = decodeMessage(genInfoBlob);
            const ctxInfoBlob = firstBytes(genInfo, 10);
            if (ctxInfoBlob) {
              const ctxInfo = decodeMessage(ctxInfoBlob);
              const est = firstInt(ctxInfo, 1);
              const cap = firstInt(ctxInfo, 4);
              if (est && est > 0) ctxEst = est;
              if (cap && cap > 0) ctxCap = cap;
            }
          }
        }
      }
    } catch {
      // Missing gen_metadata table or empty session; fall back cleanly.
    }

    const isTurnFinished = Boolean(
      currentTurn &&
        currentTurn.lastStepIdx > currentTurn.userStepIdx &&
        currentTurn.lastStepType === STEP_TYPE_PLANNER_RESPONSE &&
        currentTurn.lastStepStatus === STEP_STATUS_DONE &&
        !currentTurn.lastPlannerHasToolCalls
    );

    return {
      totalCalls,
      totalUncachedInput,
      totalOutput,
      totalCacheRead,
      ctxEst,
      ctxCap,
      prevTurn,
      currentTurn,
      isTurnFinished,
    };
  } catch {
    return null;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // Ignore close errors.
      }
    }
  }
}

module.exports = {
  resolveSessionFiles,
  readSessionDbMetrics,
};
