// SPDX-License-Identifier: MIT
// In-process payload calibration wrapper for agy-powerline on Antigravity CLI.
// Calibrates thread title, effective model context cap, cumulative uncached input/output tokens,
// current-turn cumulative cache hit rate, and zero-subprocess turn elapsed stopwatch.
"use strict";

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const { PassThrough } = require("stream");

const {
  resolveSessionFiles,
  readSessionDbMetrics,
  readSessionTitle,
  readSettingsOrchestrator,
  formatOrchestratorDisplay,
} = require("./session-metrics");
const { computeTurnElapsed } = require("./turn-elapsed");

const STDIN_TIMEOUT_MS = 1000;

function stripAnsi(str) {
  return String(str ?? "").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function formatCompactTokens(n) {
  const num = Number(n) || 0;
  if (num >= 1e6) return `${(num / 1e6).toFixed(1)}M`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(1)}K`;
  return String(Math.round(num));
}

function isOrchestratorModel(modelObj) {
  if (!modelObj || typeof modelObj !== "object") return false;
  const display = String(modelObj.display_name || "");
  const id = String(modelObj.id || "");
  return /^orchestrator\b/i.test(display) || /orchestrator/i.test(id);
}

/**
 * Resolve active Orchestrator Planner / Executor pair across payload, session DB, and settings.json.
 */
function resolveOrchestratorPair(data, db, files) {
  if (data?.orchestrator && typeof data.orchestrator === "object") {
    const p = String(data.orchestrator.planner || "").trim();
    const e = String(data.orchestrator.executor || "").trim();
    if (p || e) {
      return { planner: p, executor: e };
    }
  }

  const settingsOrch = readSettingsOrchestrator(files?.settingsPath);
  let lockMtimeMs = null;
  if (files?.lockPath) {
    try {
      lockMtimeMs = fs.statSync(files.lockPath).mtimeMs;
    } catch {
      lockMtimeMs = null;
    }
  }

  const settingsHasPair = Boolean(settingsOrch && (settingsOrch.planner || settingsOrch.executor));
  const settingsIsOrch = Boolean(settingsHasPair && /^orchestrator\b/i.test(settingsOrch.model));
  const dbOrch = db?.orchestrator && !db.orchestrator.isLegacy ? db.orchestrator : null;

  if (dbOrch) {
    const dbAnchorMs = Math.max(db.dbMtimeMs || 0, lockMtimeMs || 0);
    if (
      settingsIsOrch &&
      Number.isFinite(settingsOrch.mtimeMs) &&
      dbAnchorMs > 0 &&
      settingsOrch.mtimeMs > dbAnchorMs + 1000
    ) {
      return {
        planner: settingsOrch.planner,
        executor: settingsOrch.executor,
      };
    }
    return {
      planner: dbOrch.plannerSlug || (settingsIsOrch ? settingsOrch.planner : ""),
      executor: dbOrch.executorSlug || (settingsIsOrch ? settingsOrch.executor : ""),
    };
  }

  if (db?.orchestrator?.isLegacy) {
    return null;
  }

  if (settingsHasPair) {
    return {
      planner: settingsOrch.planner,
      executor: settingsOrch.executor,
    };
  }

  return null;
}

/**
 * Estimate Row 2's left-side column width in `raw` (no-label) mode to decide whether thinking effort fits.
 */
function estimateRow2RawLeftWidth(data, turnOutput) {
  const segments = [];
  const cw = data?.context_window;

  if (cw && typeof cw === "object") {
    const size = Number(cw.context_window_size) || 0;
    const pct = Number(cw.used_percentage) || 0;
    const used = size > 0 ? Math.round((pct * size) / 100) : 0;
    const ctxText = `${formatCompactTokens(used)}/${formatCompactTokens(size)} (${pct.toFixed(1)}%)`;
    // "💾 " (3) + 12 compact dots + " " (1) + ctxText
    segments.push(3 + 12 + 1 + ctxText.length);
  }

  const totalIn = Number(cw?.total_input_tokens) || 0;
  const totalOut = Number(cw?.total_output_tokens) || 0;
  if (totalIn + totalOut > 0) {
    const tokText = `${formatCompactTokens(totalIn)}↑ ${formatCompactTokens(totalOut)}↓`;
    // "🪙 " (3) + tokText
    segments.push(3 + tokText.length);
  }

  if (cw?.current_usage && typeof cw.current_usage === "object") {
    const cacheRead = Number(cw.current_usage.cache_read_input_tokens) || 0;
    const uncached = Number(cw.current_usage.input_tokens) || 0;
    const total = cacheRead + uncached;
    const hitPct = total > 0 ? Math.round((cacheRead * 100) / total) : 0;
    // "⚡ " (3) + `${hitPct}%`
    segments.push(3 + `${hitPct}%`.length);
  }

  const turnText = stripAnsi(turnOutput || "--").trim() || "--";
  // "⏱️ " (3) + turnText
  segments.push(3 + turnText.length);

  const dividers = 3 * Math.max(0, segments.length - 1);
  return segments.reduce((sum, w) => sum + w, 0) + dividers;
}

function readStdin(timeoutMs) {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        process.stdin.destroy();
      } catch {
        // Ignore destroy errors.
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

function enrichPayload(data) {
  if (!data || typeof data !== "object") {
    return { data, turnOutput: null };
  }

  const files = resolveSessionFiles(data);
  const db = readSessionDbMetrics(files.dbPath);

  const localTitle = readSessionTitle(files);
  if (localTitle) {
    data.conversation_title = localTitle;
  } else if (typeof data.conversation_title === "string") {
    data.conversation_title = data.conversation_title.replace(/\s+/g, " ").trim();
  }

  if (files.transcriptExists && files.transcriptPath) {
    data.transcript_path = files.transcriptPath;
  }

  // Disable hardcoded 200k critical override so statusline.config.json thresholds
  // (60% warn / 75% crit relative to the model's real effective cap) govern coloring.
  data.exceeds_200k_tokens = false;

  if (data.context_window && typeof data.context_window === "object" && db) {
    const cw = data.context_window;

    // 1. Calibrate context window to the model's actual Antigravity cap (e.g. 512K / 256K).
    if (Number.isFinite(db.ctxCap) && db.ctxCap > 0) {
      const origSize = Number(cw.context_window_size) || 0;
      const origPct = Number(cw.used_percentage);
      let usedTokens = null;
      if (Number.isFinite(db.ctxEst) && db.ctxEst > 0) {
        usedTokens = db.ctxEst;
      } else if (Number.isFinite(origPct) && origSize > 0) {
        usedTokens = Math.round((origPct * origSize) / 100);
      }

      cw.context_window_size = db.ctxCap;
      if (usedTokens !== null) {
        const pct = Math.min(100, Math.max(0, (usedTokens * 100) / db.ctxCap));
        cw.used_percentage = Number(pct.toFixed(4));
        cw.remaining_percentage = Number(Math.max(0, 100 - pct).toFixed(4));
      }
    }

    // 2. Calibrate session totals to true cumulative uncached input & cumulative output.
    if (db.totalCalls > 0) {
      cw.total_input_tokens = db.totalUncachedInput;
      cw.total_output_tokens = db.totalOutput;
    }

    // 3. Calibrate cacheHit input to current-turn cumulative cache hit (fallback: previous turn).
    const cur = db.currentTurn;
    const prev = db.prevTurn;
    const chosenTurn =
      cur && cur.uncachedInput + cur.cacheRead > 0
        ? cur
        : prev && prev.uncachedInput + prev.cacheRead > 0
          ? prev
          : null;

    if (chosenTurn) {
      if (!cw.current_usage || typeof cw.current_usage !== "object") {
        cw.current_usage = {};
      }
      cw.current_usage.input_tokens = chosenTurn.uncachedInput;
      cw.current_usage.cache_read_input_tokens = chosenTurn.cacheRead;
      cw.current_usage.cache_creation_input_tokens = 0;
    }
  }

  // 4. Pre-compute turn elapsed in-process to avoid spawning a nested cmd -> node process.
  let turnOutput = null;
  try {
    turnOutput = computeTurnElapsed(data, db, files);
  } catch {
    turnOutput = null;
  }

  // 5. Calibrate Orchestrator model display to actual Planner / Executor pair (hide effort on narrow widths).
  if (data.model && typeof data.model === "object" && isOrchestratorModel(data.model)) {
    const pair = resolveOrchestratorPair(data, db, files);
    if (pair) {
      const origDisplay = String(data.model.display_name || data.model.id || "");
      const fullLabel = formatOrchestratorDisplay(pair.planner, pair.executor, origDisplay, {
        includeEffort: true,
      });
      const termWidth =
        Number(data.terminal_width) || (process.stdout.isTTY ? process.stdout.columns : 0) || 0;
      const rawLeftWidth = estimateRow2RawLeftWidth(data, turnOutput);
      const includeEffort = !(termWidth > 0 && rawLeftWidth + 2 + fullLabel.length > termWidth);
      data.model.display_name = includeEffort
        ? fullLabel
        : formatOrchestratorDisplay(pair.planner, pair.executor, origDisplay, {
            includeEffort: false,
          });
    }
  }

  return { data, turnOutput };
}

function handoffToStatusline(jsonText, turnOutput) {
  if (turnOutput !== null) {
    const origExecSync = childProcess.execSync;
    childProcess.execSync = function patchedExecSync(command, options) {
      if (typeof command === "string" && /turn-elapsed\.js\b/i.test(command)) {
        return `${turnOutput}\n`;
      }
      return origExecSync.call(this, command, options);
    };
  }

  const fakeStdin = new PassThrough();
  Object.defineProperty(process, "stdin", {
    value: fakeStdin,
    configurable: true,
    enumerable: true,
    writable: true,
  });

  // Require agy-powerline's statusline.js in-process so it attaches listeners to fakeStdin.
  require(path.join(__dirname, "statusline.js"));

  if (jsonText) {
    fakeStdin.write(jsonText, "utf8");
  }
  fakeStdin.end();
}

if (require.main === module) {
  readStdin(STDIN_TIMEOUT_MS).then((raw) => {
    const trimmed = raw.replace(/^\uFEFF/, "").trim();
    if (!trimmed) {
      handoffToStatusline("", null);
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Let agy-powerline handle malformed JSON with its native error logging.
      handoffToStatusline(trimmed, null);
      return;
    }

    const { data, turnOutput } = enrichPayload(parsed);
    handoffToStatusline(JSON.stringify(data), turnOutput);
  });
}

module.exports = {
  enrichPayload,
  resolveOrchestratorPair,
  estimateRow2RawLeftWidth,
};
