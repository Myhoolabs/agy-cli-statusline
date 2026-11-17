// SPDX-License-Identifier: MIT
// Single-turn elapsed stopwatch for agy-powerline exec widget.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const ACTIVE_STATES = new Set(["working", "tool_use", "reviewing"]);
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

function stateFileFor(payload) {
  const identity =
    payload.transcript_path ||
    payload.workspace?.project_dir ||
    payload.workspace?.current_dir ||
    payload.cwd ||
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
        latestAfterUser = { stepIdx: idx, ms: ts };
      }
    }

    return {
      unchanged: false,
      mtimeMs: stat.mtimeMs,
      userStepIdx: latestUser ? latestUser.stepIdx : null,
      userMs: latestUser ? latestUser.ms : null,
      lastStepIdx: latestAfterUser ? latestAfterUser.stepIdx : null,
      lastMs: latestAfterUser ? latestAfterUser.ms : null,
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

function main() {
  const now = Date.now();
  const payload = readPayload();
  const stateFile = stateFileFor(payload);
  const state = loadState(stateFile);
  const prevSerialized = JSON.stringify(state);

  const agentState = String(payload.agent_state || "").toLowerCase();
  const isActive = ACTIVE_STATES.has(agentState) || payload.tool_confirmation_pending === true;
  const transcriptPath = payload.transcript_path;

  let output;
  if (isActive) {
    if (!state.active || !Number.isFinite(state.startedAt)) {
      let startedAt = now;
      // On cold start mid-turn, recover the current prompt start time if recent.
      if (state.lastSeenAt === null && transcriptPath) {
        const tail = inspectTranscriptTail(transcriptPath, 0);
        if (tail && !tail.unchanged && Number.isFinite(tail.userMs) && now - tail.userMs < 3600_000) {
          startedAt = Math.min(now, tail.userMs);
          if (Number.isFinite(tail.userStepIdx)) {
            state.seenUserStepIdx = tail.userStepIdx;
          }
          state.lastTranscriptMtimeMs = tail.mtimeMs;
        }
      }
      state.active = true;
      state.startedAt = startedAt;
    }
    state.lastSeenAt = now;
    const elapsedSec = Math.max(0, (now - state.startedAt) / 1000);
    output = `\x1b[33m${formatDuration(elapsedSec)}\x1b[0m`;
  } else {
    const tail = inspectTranscriptTail(transcriptPath, state.lastTranscriptMtimeMs);
    if (state.active && Number.isFinite(state.startedAt)) {
      state.lastElapsedSec = Math.max(0, (now - state.startedAt) / 1000);
      state.active = false;
      state.startedAt = null;
      if (tail && !tail.unchanged) {
        if (Number.isFinite(tail.userStepIdx)) {
          state.seenUserStepIdx = tail.userStepIdx;
        }
        state.lastTranscriptMtimeMs = tail.mtimeMs;
      }
    } else if (tail && !tail.unchanged) {
      if (
        Number.isFinite(tail.userStepIdx) &&
        tail.userStepIdx > state.seenUserStepIdx &&
        Number.isFinite(tail.lastStepIdx) &&
        tail.lastStepIdx > tail.userStepIdx &&
        Number.isFinite(tail.userMs) &&
        Number.isFinite(tail.lastMs)
      ) {
        state.lastElapsedSec = Math.max(0, (tail.lastMs - tail.userMs) / 1000);
        state.seenUserStepIdx = tail.userStepIdx;
      }
      state.lastTranscriptMtimeMs = tail.mtimeMs;
    }
    state.lastSeenAt = now;
    output = state.lastElapsedSec !== null ? formatDuration(state.lastElapsedSec) : "--";
  }

  if (JSON.stringify(state) !== prevSerialized) {
    saveState(stateFile, state);
  }
  process.stdout.write(`${output}\n`);
}

main();
