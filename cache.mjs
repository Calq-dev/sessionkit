// The cache state of one Claude Code session, read from the end of its transcript: how large
// the context is, what one more call costs in cache reads, how long the cache stays warm, and
// what the first call costs once it has gone cold.
//
// Used by the status line and by the warning before a cold call. It reads only the last part of
// the transcript, so it stays fast on a transcript of tens of megabytes.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { priceOf } from "./usage.mjs";

const TAIL_BYTES = 2 * 1024 * 1024;
const FIVE_MINUTES = 5 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

function readTail(path) {
  const size = statSync(path).size;
  const length = Math.min(size, TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const handle = openSync(path, "r");
  try { readSync(handle, buffer, 0, length, size - length); } finally { closeSync(handle); }
  return buffer.toString("utf8");
}

/**
 * The last API call of the main conversation, and whether this session writes its cache for
 * one hour or for five minutes. Subagent calls live in other files and are not counted here.
 */
function lastCall(transcriptPath) {
  const lines = readTail(transcriptPath).split("\n").reverse();
  let last = null, oneHour = false;
  for (const line of lines) {
    if (!line.includes('"usage"')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }   // the first line of the tail can be cut
    const usage = entry.message?.usage;
    if (entry.type !== "assistant" || entry.isSidechain || !usage || entry.message.model === "<synthetic>") continue;
    if ((usage.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0) oneHour = true;
    last ??= {
      time: Date.parse(entry.timestamp),
      model: entry.message.model,
      fast: usage.speed === "fast",
      context: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      read: usage.cache_read_input_tokens ?? 0,
      write: usage.cache_creation_input_tokens ?? 0,
    };
    if (last && oneHour) break;
  }
  return last ? { ...last, ttl: oneHour ? ONE_HOUR : FIVE_MINUTES } : null;
}

/**
 * The cache state now. perCall is the cache-read cost of one more call at this context; coldCall
 * is what the first call costs when the cache has expired: the whole context written again.
 */
function cacheState(transcriptPath, now = Date.now()) {
  let call;
  try { call = lastCall(transcriptPath); } catch { return null; }
  if (!call) return null;
  const price = priceOf(call.model);
  const factor = call.fast ? 2 : 1;
  const writeFactor = call.ttl === ONE_HOUR ? 2 : 1.25;
  const left = call.time + call.ttl - now;
  return {
    context: call.context,
    model: call.model,
    lastCallTime: call.time,
    lastCallCold: call.write > call.read,
    ttl: call.ttl,
    warm: left > 0,
    left: Math.max(0, left),
    perCall: price ? (call.context * (price.read ?? price.input * 0.1) * factor) / 1e6 : null,
    coldCall: price ? (call.context * price.input * writeFactor * factor) / 1e6 : null,
  };
}

export { cacheState };
