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
  let annotationPath = null;
  let summariesDbPath = null;
  let settingsPath = null;
  let lockPath = null;
  const dataDirs = [inferCliDataDir(transcriptPath), defaultCliDataDir()];
  const seenDirs = new Set();

  for (const dir of dataDirs) {
    if (!dir || seenDirs.has(dir)) continue;
    seenDirs.add(dir);

    if (conversationId) {
      if (!dbPath) {
        const dbCandidate = path.join(dir, "conversations", `${conversationId}.db`);
        if (fileExists(dbCandidate)) {
          dbPath = dbCandidate;
        }
      }
      if (!annotationPath) {
        const annCandidate = path.join(dir, "annotations", `${conversationId}.pbtxt`);
        if (fileExists(annCandidate)) {
          annotationPath = annCandidate;
        }
      }
      if (!lockPath) {
        const lockCandidate = path.join(dir, "presence", `${conversationId}.lock`);
        if (fileExists(lockCandidate)) {
          lockPath = lockCandidate;
        }
      }
    }

    if (!summariesDbPath) {
      const sumCandidate = path.join(dir, "conversation_summaries.db");
      if (fileExists(sumCandidate)) {
        summariesDbPath = sumCandidate;
      }
    }

    if (!settingsPath) {
      const settingsCandidate = path.join(dir, "settings.json");
      if (fileExists(settingsCandidate)) {
        settingsPath = settingsCandidate;
      }
    }
  }

  return {
    conversationId,
    rawTranscriptPath: rawTranscript || null,
    transcriptPath: transcriptPath || (rawTranscript || null),
    transcriptExists: Boolean(transcriptPath),
    dbPath,
    annotationPath,
    summariesDbPath,
    settingsPath,
    lockPath,
  };
}

function normalizeTitle(text) {
  if (typeof text !== "string") return "";
  return text.replace(/\s+/g, " ").trim();
}

function unescapePbtxtString(escaped) {
  if (typeof escaped !== "string" || !escaped) return "";
  let out = "";
  let byteBuf = [];

  const flushBytes = () => {
    if (byteBuf.length > 0) {
      out += Buffer.from(byteBuf).toString("utf8");
      byteBuf = [];
    }
  };

  for (let i = 0; i < escaped.length; i += 1) {
    const ch = escaped[i];
    if (ch !== "\\" || i + 1 >= escaped.length) {
      flushBytes();
      out += ch;
      continue;
    }

    const next = escaped[i + 1];
    if (next >= "0" && next <= "7") {
      const octMatch = escaped.slice(i + 1, i + 4).match(/^[0-7]{1,3}/);
      if (octMatch) {
        byteBuf.push(parseInt(octMatch[0], 8) & 0xff);
        i += octMatch[0].length;
        continue;
      }
    }

    if (next === "x" || next === "X") {
      const hexMatch = escaped.slice(i + 2, i + 4).match(/^[0-9a-fA-F]{2}/);
      if (hexMatch) {
        byteBuf.push(parseInt(hexMatch[0], 16) & 0xff);
        i += 1 + hexMatch[0].length;
        continue;
      }
    }

    flushBytes();

    if (next === "u") {
      const uMatch = escaped.slice(i + 2, i + 6).match(/^[0-9a-fA-F]{4}/);
      if (uMatch) {
        out += String.fromCodePoint(parseInt(uMatch[0], 16));
        i += 5;
        continue;
      }
    } else if (next === "U") {
      const uMatch = escaped.slice(i + 2, i + 10).match(/^[0-9a-fA-F]{8}/);
      if (uMatch) {
        const cp = parseInt(uMatch[0], 16);
        if (cp <= 0x10ffff) {
          out += String.fromCodePoint(cp);
        }
        i += 9;
        continue;
      }
    }

    const simpleEscapes = {
      '"': '"',
      "'": "'",
      "\\": "\\",
      n: "\n",
      r: "\r",
      t: "\t",
      a: "\x07",
      b: "\b",
      f: "\f",
      v: "\v",
    };
    if (Object.hasOwn(simpleEscapes, next)) {
      out += simpleEscapes[next];
      i += 1;
      continue;
    }

    out += next;
    i += 1;
  }

  flushBytes();
  return out;
}

function parseAnnotationTitle(pbtxtText) {
  if (typeof pbtxtText !== "string" || !pbtxtText) return null;
  const match = pbtxtText.match(/(?:^|[\s{])title\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (!match) return null;
  const title = normalizeTitle(unescapePbtxtString(match[1]));
  return title || null;
}

function readSessionTitle(files) {
  if (files?.annotationPath && fileExists(files.annotationPath)) {
    try {
      const raw = fs.readFileSync(files.annotationPath, "utf8");
      const parsed = parseAnnotationTitle(raw);
      if (parsed) return parsed;
    } catch {
      // Ignore annotation read errors and fall back to summaries DB.
    }
  }

  if (files?.conversationId && files?.summariesDbPath && fileExists(files.summariesDbPath)) {
    const DatabaseSync = getDatabaseSync();
    if (DatabaseSync) {
      let db;
      try {
        db = new DatabaseSync(files.summariesDbPath, { readOnly: true, timeout: 250 });
        const row = db
          .prepare("SELECT title FROM conversation_summaries WHERE conversation_id = ?")
          .get(files.conversationId);
        const title = normalizeTitle(row?.title);
        if (title) return title;
      } catch {
        // Missing table or locked DB; fall back cleanly.
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
  }

  return null;
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

const SLUG_TO_LABEL = {
  "gemini-4-neon-low": "Gemini 4 Neon (Low)",
  "gemini-4-neon-medium": "Gemini 4 Neon (Medium)",
  "gemini-4-neon-high": "Gemini 4 Neon (High)",
  "gemini-4-neon-xhigh": "Gemini 4 Neon (XHigh)",
  "gemini-4-carbon-low": "Gemini 4 Carbon (Low)",
  "gemini-4-carbon-medium": "Gemini 4 Carbon (Medium)",
  "gemini-4-carbon-high": "Gemini 4 Carbon (High)",
  "gemini-4-argon-low": "Gemini 4 Argon (Low)",
  "gemini-4-argon-medium": "Gemini 4 Argon (Medium)",
  "gemini-4-argon-high": "Gemini 4 Argon (High)",
  "gemini-4-hydrogen-low": "Gemini 4 Hydrogen (Low)",
  "gemini-4-hydrogen-medium": "Gemini 4 Hydrogen (Medium)",
  "gemini-4-hydrogen-high": "Gemini 4 Hydrogen (High)",
  "gemini-4-hydrogen-xhigh": "Gemini 4 Hydrogen (XHigh)",
  "gemini-3.8-flash-low": "Gemini 3.8 Flash (Low)",
  "gemini-3.8-flash-medium": "Gemini 3.8 Flash (Medium)",
  "gemini-3.8-flash-high": "Gemini 3.8 Flash (High)",
  "claude-opus-5-5-low": "Claude Opus 5.5 (Low)",
  "claude-opus-5-5-medium": "Claude Opus 5.5 (Medium)",
  "claude-opus-5-5-high": "Claude Opus 5.5 (High)",
  "claude-sonnet-5-5-low": "Claude Sonnet 5.5 (Low)",
  "claude-sonnet-5-5-medium": "Claude Sonnet 5.5 (Medium)",
  "claude-sonnet-5-5-high": "Claude Sonnet 5.5 (High)",
  "gpt-oss-120b-medium": "GPT-OSS 120B (Medium)",
  "gemini-pro-orchestrator-neon": "Orchestrator (Neon)",
  "gemini-pro-orchestrator": "Orchestrator (Carbon)",
  "gemini-pro-orchestrator-argon": "Orchestrator (Argon)",
  "gemini-pro-orchestrator-g1-pro": "Orchestrator (Argon)",
};

const MODEL_ENUM_TO_SLUG = {
  342: "gpt-oss-120b-medium",
  1318: "gemini-3.8-flash-high",
  1402: "claude-opus-5-5-high",
  1405: "claude-sonnet-5-5-high",
  1417: "gemini-4-argon-high",
  1418: "gemini-4-argon-medium",
  1427: "gemini-4-carbon-high",
  1525: "gemini-4-hydrogen-high",
  1526: "gemini-4-hydrogen-medium",
  1527: "gemini-4-hydrogen-low",
  1528: "gemini-4-hydrogen-xhigh",
  1532: "gemini-4-neon-high",
  1533: "gemini-4-neon-medium",
  1535: "gemini-4-neon-xhigh",
  1537: "gemini-pro-orchestrator-neon",
  1668: "gemini-pro-orchestrator-g1-pro",
  1669: "gemini-flash-worker-agy",
};

const LEGACY_ORCHESTRATOR_PLANNER_SLUGS = new Set([
  "gemini-pro-orchestrator-neon",
  "gemini-pro-orchestrator-g1-pro",
]);

const LEGACY_ORCHESTRATOR_WORKER_SLUGS = new Set(["gemini-flash-worker-agy"]);

const EFFORT_SHORT_MAP = {
  low: "Low",
  medium: "Med",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

/**
 * Format a model label or slug into compact `agy -r` style (e.g. `Neon High`, `Hydrogen Med`).
 */
function compactModelName(raw, { includeEffort = true } = {}) {
  const input = String(raw ?? "").trim();
  if (!input) return "";

  const mapped = SLUG_TO_LABEL[input.toLowerCase()];
  const text = mapped || input;

  // Human label format (contains whitespace or trailing "(...)").
  if (/\s/.test(text) || /\([^)]+\)\s*$/.test(text)) {
    let effort = "";
    let base = text;
    const m = text.match(/^(.*?)\s*\((Low|Medium|High|XHigh|Max)\)\s*$/i);
    if (m) {
      base = m[1].trim();
      effort = EFFORT_SHORT_MAP[m[2].toLowerCase()] || m[2];
    }
    const shortBase =
      base.replace(/^(?:Gemini|Claude)\s+(?:\d+(?:\.\d+)?\s+)?/i, "").trim() || base;
    return includeEffort && effort ? `${shortBase} ${effort}` : shortBase;
  }

  // Fallback for unknown future slugs (e.g. `gemini-4-carbon-xhigh`, `claude-opus-6-0-high`).
  let slug = text.toLowerCase();
  let effort = "";
  const effortMatch = slug.match(/-(low|medium|high|xhigh|max)$/);
  if (effortMatch) {
    effort = EFFORT_SHORT_MAP[effortMatch[1]] || effortMatch[1];
    slug = slug.slice(0, effortMatch.index);
  }
  slug = slug.replace(/^(?:gemini-\d+(?:\.\d+)?-|claude-)/, "");
  slug = slug.replace(/(\d+)-(\d+)/g, "$1.$2");
  const shortBase = slug
    .split("-")
    .filter(Boolean)
    .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
  if (!shortBase) return text;
  return includeEffort && effort ? `${shortBase} ${effort}` : shortBase;
}

/**
 * Format Planner / Executor pair into `Orch (Neon High / Hydrogen Med)` or `Orch (Neon / Hydrogen)`.
 */
function formatOrchestratorDisplay(
  plannerRaw,
  executorRaw,
  fallbackDisplay,
  { includeEffort = true } = {}
) {
  const p = compactModelName(plannerRaw, { includeEffort });
  const e = compactModelName(executorRaw, { includeEffort });
  if (p && e) return `Orch (${p} / ${e})`;
  if (p) return `Orch (${p})`;
  if (e) return `Orch (? / ${e})`;
  return fallbackDisplay || "";
}

/**
 * Decode one `executor_metadata.data` protobuf row into `{ modelEnum, slug, hasPlanExecute, execEnum }`.
 */
function parseExecutorMetaRow(buf) {
  let modelEnum = null;
  let slug = "";
  let hasPlanExecute = false;
  let execEnum = null;

  const top = decodeMessage(buf);
  const f10List = top.get(10) || [];
  for (const val of f10List) {
    if (!(val instanceof Uint8Array)) continue;
    const sub1 = decodeMessage(val);
    const f1List = sub1.get(1) || [];
    for (const v1 of f1List) {
      if (!(v1 instanceof Uint8Array)) continue;
      const sub2 = decodeMessage(v1);

      const mEnum = firstInt(sub2, 1);
      if (mEnum !== null) modelEnum = mEnum;

      const sText = firstText(sub2, 28).trim();
      if (sText) slug = sText;

      const peList = sub2.get(46) || [];
      for (const peVal of peList) {
        if (peVal instanceof Uint8Array) {
          const peText = Buffer.from(peVal.buffer, peVal.byteOffset, peVal.byteLength).toString(
            "utf8"
          );
          if (peText.includes("plan_execute_protocol")) {
            hasPlanExecute = true;
          }
        }
      }

      const f60List = sub2.get(60) || [];
      for (const f60Val of f60List) {
        if (!(f60Val instanceof Uint8Array)) continue;
        const sub60 = decodeMessage(f60Val);
        const eEnum = firstInt(sub60, 1);
        if (eEnum !== null) execEnum = eEnum;
      }
    }
  }

  return { modelEnum, slug, hasPlanExecute, execEnum };
}

function readSettingsOrchestrator(settingsPath) {
  if (!settingsPath || !fileExists(settingsPath)) return null;
  try {
    const mtimeMs = fs.statSync(settingsPath).mtimeMs;
    const raw = fs.readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, "");
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;
    return {
      model: typeof obj.model === "string" ? obj.model.trim() : "",
      planner: typeof obj.orchestrator?.planner === "string" ? obj.orchestrator.planner.trim() : "",
      executor:
        typeof obj.orchestrator?.executor === "string" ? obj.orchestrator.executor.trim() : "",
      mtimeMs,
    };
  } catch {
    return null;
  }
}

function readSessionDbMetrics(dbPath) {
  if (!dbPath || !fileExists(dbPath)) return null;
  const DatabaseSync = getDatabaseSync();
  if (!DatabaseSync) return null;

  let dbMtimeMs = null;
  try {
    dbMtimeMs = fs.statSync(dbPath).mtimeMs;
  } catch {
    dbMtimeMs = null;
  }

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

    // Extract latest Orchestrator (Planner / Executor) spec from executor_metadata if present.
    let orchestrator = null;
    try {
      const execRows = db
        .prepare("SELECT data FROM executor_metadata ORDER BY idx DESC LIMIT 60")
        .all();
      const learnedEnums = { ...MODEL_ENUM_TO_SLUG };
      const parsedExec = [];
      for (const row of execRows) {
        if (!row?.data) continue;
        try {
          const parsed = parseExecutorMetaRow(row.data);
          if (parsed.modelEnum !== null && parsed.slug && !Object.hasOwn(learnedEnums, parsed.modelEnum)) {
            learnedEnums[parsed.modelEnum] = parsed.slug;
          }
          if (
            parsed.modelEnum !== null ||
            parsed.slug ||
            parsed.hasPlanExecute ||
            parsed.execEnum !== null
          ) {
            parsedExec.push(parsed);
          }
        } catch {
          // Ignore malformed protobuf row.
        }
      }

      if (parsedExec.length > 0) {
        const latest = parsedExec[0];
        if (latest.hasPlanExecute || latest.execEnum !== null) {
          const targetExecEnum = latest.execEnum;
          let plannerSlug = "";
          let executorSlug = "";
          for (const row of parsedExec) {
            if (!row.hasPlanExecute && row.execEnum === null) break;
            if (targetExecEnum !== null && row.modelEnum === targetExecEnum) {
              if (!executorSlug && row.slug) executorSlug = row.slug;
            } else {
              if (!plannerSlug && row.slug) plannerSlug = row.slug;
            }
            if (plannerSlug && executorSlug) break;
          }
          if (!executorSlug && targetExecEnum !== null) {
            executorSlug = learnedEnums[targetExecEnum] || "";
          }
          const isLegacy =
            LEGACY_ORCHESTRATOR_PLANNER_SLUGS.has(plannerSlug) &&
            (!executorSlug || LEGACY_ORCHESTRATOR_WORKER_SLUGS.has(executorSlug));
          orchestrator = { plannerSlug, executorSlug, isLegacy };
        }
      }
    } catch {
      // Missing executor_metadata table or empty session; fall back cleanly.
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
      orchestrator,
      dbMtimeMs,
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
  readSessionTitle,
  parseAnnotationTitle,
  readSettingsOrchestrator,
  compactModelName,
  formatOrchestratorDisplay,
  parseExecutorMetaRow,
};
