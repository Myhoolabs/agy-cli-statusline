// SPDX-License-Identifier: MIT
// In-process payload calibration wrapper for agy-powerline on Antigravity CLI.
// Calibrates thread title, effective model context cap, cumulative uncached input/output tokens,
// current-turn cumulative cache hit rate, and zero-subprocess turn elapsed stopwatch.
"use strict";

const path = require("path");
const childProcess = require("child_process");
const { PassThrough } = require("stream");

const { resolveSessionFiles, readSessionDbMetrics, readSessionTitle } = require("./session-metrics");
const { computeTurnElapsed } = require("./turn-elapsed");

const STDIN_TIMEOUT_MS = 1000;

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
