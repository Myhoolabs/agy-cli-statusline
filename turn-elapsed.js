// SPDX-License-Identifier: MIT
// Single-turn elapsed stopwatch for agy-powerline exec widget and statusline-enrich wrapper.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const { resolveSessionFiles, readSessionDbMetrics } = require("./session-metrics");

// Only count active generation / tool execution; do not count "reviewing" (waiting for user).
const ACTIVE_STATES = new Set(["working", "tool_use"]);
const STATE_DIR = path.join(os.tmpdir(), "agy-turn-elapsed");
const CHUNK_BYTES = 131072;
const MAX_SCAN_BYTES = 4 * 1024 * 1024;

function readPayload() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function formatDuration(totalSec) {
  const sec = Math.max(0, Math.round(totalSec));
  if (sec < 60) return `${sec}s`;
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function stateFileFor(payload, files) {
  const identity =
    files?.conversationId ||
    files?.dbPath ||
    files?.transcriptPath ||
    payload?.transcript_path ||
    payload?.workspace?.project_dir ||
    payload?.workspace?.current_dir ||
    payload?.cwd ||
    "default";
  const key = crypto.createHash("sha1").update(String(identity)).digest("hex").slice(0, 16);
  return path.join(STATE_DIR, `${key}.json`);
}

function loadState(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data && typeof data === "object") {
      return {
        active: Boolean(data.active),
        startedAt: Number.isFinite(data.startedAt) ? data.startedAt : null,
        lastElapsedSec: Number.isFinite(data.lastElapsedSec) ? data.lastElapsedSec : null,
        seenUserStepIdx: Number.isFinite(data.seenUserStepIdx) ? data.seenUserStepIdx : -1,
        lastTranscriptMtimeMs: Number.isFinite(data.lastTranscriptMtimeMs)
          ? data.lastTranscriptMtimeMs
          : 0,
        lastSeenAt: Number.isFinite(data.lastSeenAt) ? data.lastSeenAt : null,
      };
    }
  } catch {
    // Missing or unreadable state file: start fresh.
  }
  return {
    active: false,
    startedAt: null,
    lastElapsedSec: null,
    seenUserStepIdx: -1,
    lastTranscriptMtimeMs: 0,
    lastSeenAt: null,
  };
}

function saveState(file, state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), "utf8");
    fs.renameSync(tmp, file);
  } catch {
    // Best-effort state persistence; never break statusline rendering.
  }
}

function inspectTranscriptTail(transcriptPath, cachedMtimeMs) {
  if (!transcriptPath || typeof transcriptPath !== "string") return null;
  let stat;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size <= 0) return null;
  if (cachedMtimeMs && stat.mtimeMs === cachedMtimeMs) {
    return { unchanged: true, mtimeMs: stat.mtimeMs };
  }

  let fd;
  try {
    fd = fs.openSync(transcriptPath, "r");
    const minStart = Math.max(0, stat.size - MAX_SCAN_BYTES);
    let pos = stat.size;
    let tailText = "";
    let foundUserInput = false;

    while (pos > minStart) {
      const nextPos = Math.max(minStart, pos - CHUNK_BYTES);
      const len = pos - nextPos;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, nextPos);
      tailText = buf.toString("utf8") + tailText;
      pos = nextPos;
      const marker = tailText.lastIndexOf('"USER_INPUT"');
      if (marker !== -1 && (pos === 0 || tailText.lastIndexOf("\n", marker) !== -1)) {
        foundUserInput = true;
        break;
      }
    }

    if (!foundUserInput) {
      return { unchanged: false, mtimeMs: stat.mtimeMs };
    }

    const lines = tailText.split(/\r?\n/);
    if (pos > 0 && lines.length > 0) lines.shift();

    let latestUser = null;
    let latestAfterUser = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const idx = Number(entry?.step_index);
      const ts = Date.parse(entry?.created_at);
      if (!Number.isFinite(idx) || !Number.isFinite(ts)) continue;
      if (entry.type === "USER_INPUT") {
        latestUser = { stepIdx: idx, ms: ts };
        latestAfterUser = null;
      } else if (latestUser && idx > latestUser.stepIdx) {
        const hasToolCalls = Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0;
        latestAfterUser = {
          stepIdx: idx,
          ms: ts,
          type: String(entry.type || ""),
          status: String(entry.status || ""),
          hasToolCalls,
        };
      }
    }

    const isTurnFinished = Boolean(
      latestUser &&
        latestAfterUser &&
        latestAfterUser.type === "PLANNER_RESPONSE" &&
        latestAfterUser.status === "DONE" &&
        !latestAfterUser.hasToolCalls
    );

    return {
      unchanged: false,
      mtimeMs: stat.mtimeMs,
      userStepIdx: latestUser ? latestUser.stepIdx : null,
      userMs: latestUser ? latestUser.ms : null,
      lastStepIdx: latestAfterUser ? latestAfterUser.stepIdx : null,
      lastMs: latestAfterUser ? latestAfterUser.ms : null,
      isTurnFinished,
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore
      }
    }
  }
}

function computeTurnElapsed(payload, preloadedDb = undefined, preloadedFiles = undefined) {
  const now = Date.now();
  const files = preloadedFiles || resolveSessionFiles(payload);
  const db = preloadedDb !== undefined ? preloadedDb : readSessionDbMetrics(files.dbPath);

  const stateFile = stateFileFor(payload, files);
  const state = loadState(stateFile);
  const prevSerialized = JSON.stringify(state);

  const agentState = String(payload?.agent_state || "").toLowerCase();
  const isActiveState =
    ACTIVE_STATES.has(agentState) || payload?.tool_confirmation_pending === true;

  let output;

  // Priority 1: Authoritative per-turn timestamps & completion status from session SQLite DB.
  if (db && db.currentTurn && Number.isFinite(db.currentTurn.userStepIdx)) {
    const turn = db.currentTurn;
    const isStoppedIdle = agentState === "idle";
    const isFinished = db.isTurnFinished || isStoppedIdle;

    if (isFinished) {
      const startMs = Number.isFinite(turn.userMs)
        ? turn.userMs
        : Number.isFinite(state.startedAt) && state.seenUserStepIdx === turn.userStepIdx
          ? state.startedAt
          : now;
      const endMs = Number.isFinite(turn.lastStepEndMs)
        ? turn.lastStepEndMs
        : Number.isFinite(turn.lastStepStartMs) && turn.lastStepIdx > turn.userStepIdx
          ? turn.lastStepStartMs
          : state.active && state.seenUserStepIdx === turn.userStepIdx
            ? now
            : startMs;
      const elapsedSec = Math.max(0, (endMs - startMs) / 1000);
      state.active = false;
      state.startedAt = null;
      state.lastElapsedSec = elapsedSec;
      state.seenUserStepIdx = turn.userStepIdx;
      state.lastSeenAt = now;
      output = formatDuration(elapsedSec);
    } else {
      // Active turn: reset timer immediately whenever a newer USER_INPUT step appears.
      const isNewTurn = turn.userStepIdx !== state.seenUserStepIdx;
      let startedAt = state.startedAt;
      if (!state.active || !Number.isFinite(startedAt) || isNewTurn) {
        startedAt = Number.isFinite(turn.userMs) ? Math.min(now, turn.userMs) : now;
      } else if (
        Number.isFinite(turn.userMs) &&
        Math.abs(startedAt - turn.userMs) > 5000
      ) {
        startedAt = Math.min(now, turn.userMs);
      }
      state.active = true;
      state.startedAt = startedAt;
      state.seenUserStepIdx = turn.userStepIdx;
      state.lastSeenAt = now;
      const elapsedSec = Math.max(0, (now - startedAt) / 1000);
      output = `\x1b[33m${formatDuration(elapsedSec)}\x1b[0m`;
    }
  } else {
    // Priority 2: Transcript-assisted fallback (supports corrected -cli paths & synthetic tests).
    const transcriptPath = files.transcriptExists ? files.transcriptPath : null;
    const tail = transcriptPath ? inspectTranscriptTail(transcriptPath, 0) : null;

    if (tail && Number.isFinite(tail.userStepIdx)) {
      const turnHasProgress =
        Number.isFinite(tail.lastStepIdx) && tail.lastStepIdx > tail.userStepIdx;
      const isFinished = tail.isTurnFinished || (!isActiveState && turnHasProgress);

      if (isFinished) {
        let elapsedSec;
        if (
          state.active &&
          Number.isFinite(state.startedAt) &&
          state.seenUserStepIdx === tail.userStepIdx &&
          !isActiveState
        ) {
          elapsedSec = Math.max(0, (now - state.startedAt) / 1000);
        } else if (Number.isFinite(tail.userMs) && Number.isFinite(tail.lastMs)) {
          elapsedSec = Math.max(0, (tail.lastMs - tail.userMs) / 1000);
        } else {
          elapsedSec = state.lastElapsedSec ?? 0;
        }
        state.active = false;
        state.startedAt = null;
        state.lastElapsedSec = elapsedSec;
        state.seenUserStepIdx = tail.userStepIdx;
        state.lastTranscriptMtimeMs = tail.mtimeMs;
        state.lastSeenAt = now;
        output = formatDuration(elapsedSec);
      } else if (isActiveState) {
        const isNewTurn = tail.userStepIdx !== state.seenUserStepIdx;
        let startedAt = state.startedAt;
        if (!state.active || !Number.isFinite(startedAt) || isNewTurn) {
          startedAt =
            Number.isFinite(tail.userMs) && now - tail.userMs < 3600_000
              ? Math.min(now, tail.userMs)
              : now;
        }
        state.active = true;
        state.startedAt = startedAt;
        state.seenUserStepIdx = tail.userStepIdx;
        state.lastTranscriptMtimeMs = tail.mtimeMs;
        state.lastSeenAt = now;
        const elapsedSec = Math.max(0, (now - startedAt) / 1000);
        output = `\x1b[33m${formatDuration(elapsedSec)}\x1b[0m`;
      } else {
        state.active = false;
        state.startedAt = null;
        state.lastTranscriptMtimeMs = tail.mtimeMs;
        state.lastSeenAt = now;
        output = state.lastElapsedSec !== null ? formatDuration(state.lastElapsedSec) : "--";
      }
    } else if (isActiveState) {
      // Priority 3: Pure agent_state fallback (e.g. brand-new empty session or doctor mock payload).
      if (!state.active || !Number.isFinite(state.startedAt)) {
        state.active = true;
        state.startedAt = now;
      }
      state.lastSeenAt = now;
      const elapsedSec = Math.max(0, (now - state.startedAt) / 1000);
      output = `\x1b[33m${formatDuration(elapsedSec)}\x1b[0m`;
    } else {
      if (state.active && Number.isFinite(state.startedAt)) {
        state.lastElapsedSec = Math.max(0, (now - state.startedAt) / 1000);
        state.active = false;
        state.startedAt = null;
      }
      state.lastSeenAt = now;
      output = state.lastElapsedSec !== null ? formatDuration(state.lastElapsedSec) : "--";
    }
  }

  if (JSON.stringify(state) !== prevSerialized) {
    saveState(stateFile, state);
  }
  return output;
}

if (require.main === module) {
  const payload = readPayload();
  const output = computeTurnElapsed(payload);
  process.stdout.write(`${output}\n`);
}

module.exports = {
  computeTurnElapsed,
  formatDuration,
};
