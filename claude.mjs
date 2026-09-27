// sessionkit statusline and sessionkit hook — show in Claude Code what the prompt cache costs.
//
// Claude Code does not show that a session with 800k tokens of context re-reads all of them on
// every call, or that the first call after an idle hour writes them all again. These commands do:
//
//   statusline           context, cost per call (or, on a subscription, the usage limits and an
//                        estimate of what one call takes from them), and the cache time
//   hook session-start   on --resume: what the first request will cost when the cache is cold
//   hook prompt          before a message to a cold, expensive session: stop it once and say why
//
// Everything here reaches the user only (the status line, systemMessage, a block reason). Nothing
// is added to Claude's context, so the checks cost no tokens.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { cacheState } from "./cache.mjs";
import { priceOf } from "./usage.mjs";

const setting = (name) => process.env[`SESSIONKIT_${name}`];
const WARN_RESUME_ABOVE_USD = Number(setting("WARN_RESUME_ABOVE") ?? 1);
const BLOCK_COLD_ABOVE_USD = Number(setting("BLOCK_COLD_ABOVE") ?? 2);
const CACHE_DIR = join(homedir(), ".cache", "sessionkit");
const ACK_DIR = join(CACHE_DIR, "cold-ack");
const LIMIT_STATE_DIR = join(CACHE_DIR, "limit-state");
const LIMIT_SAMPLES = join(CACHE_DIR, "limit-samples.jsonl");
const LIMIT_SAMPLE_WINDOW = 100;     // the newest warm calls the estimate uses
const LIMIT_MIN_SAMPLES = 5;
const LIMIT_FRESH_MS = 3 * 60 * 1000; // a delta over a longer gap mixes in other sessions' calls
const SOON_MS = 10 * 60 * 1000;

const COLOR = { green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", dim: "\x1b[2m", reset: "\x1b[0m" };

async function readInput() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  try { return JSON.parse(text); } catch { return {}; }
}

const tokens = (value) => (value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : `${Math.round(value / 1e3)}K`);
const usd = (value) => (value >= 10 ? `$${value.toFixed(0)}` : value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(3)}`);
const minutes = (ms) => (ms >= 3600000 ? `${Math.floor(ms / 3600000)}h${String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0")}` : `${Math.max(1, Math.round(ms / 60000))}m`);
const sessionId = (input) => input.session_id ?? basename(input.transcript_path ?? "", ".jsonl");

/**
 * The cache state, from what Claude Code hands the status line when it has it, and from the
 * transcript otherwise: before the first response of a resumed session there is no prompt_cache.
 */
function stateFor(input) {
  const fromTranscript = input.transcript_path && existsSync(input.transcript_path) ? cacheState(input.transcript_path) : null;
  const usage = input.context_window?.current_usage;
  const model = input.model?.id ?? fromTranscript?.model;
  const price = priceOf(model);
  const context = usage
    ? (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
    : fromTranscript?.context;
  if (!context || !price) return fromTranscript;
  const factor = input.fast_mode ? 2 : 1;
  const writeFactor = fromTranscript?.ttl === 5 * 60 * 1000 ? 1.25 : 2;
  const cache = input.prompt_cache;
  const warm = cache ? cache.warm : fromTranscript?.warm ?? false;
  const left = cache?.expires_at ? Math.max(0, cache.expires_at * 1000 - Date.now()) : fromTranscript?.left ?? 0;
  return {
    context,
    model,
    warm,
    left,
    lastCallTime: fromTranscript?.lastCallTime,
    lastCallCold: fromTranscript?.lastCallCold ?? false,
    perCall: (context * (price.read ?? price.input * 0.1) * factor) / 1e6,
    coldCall: (context * price.input * writeFactor * factor) / 1e6,
  };
}

// ---------------------------------------------------------------- subscription limits

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function readSamples() {
  if (!existsSync(LIMIT_SAMPLES)) return [];
  return readFileSync(LIMIT_SAMPLES, "utf8").split("\n").map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

/**
 * Learn what one call takes from the 5-hour limit. Anthropic does not publish how tokens map to
 * the limit, so every status line update compares the limit with the previous update of this
 * session: when one new call came in between, and that update is recent, the increase belongs
 * mostly to that call. Other sessions running at the same time add noise that stays in.
 */
function learnLimit(id, fiveHour, state) {
  if (!state.lastCallTime || typeof fiveHour?.used_percentage !== "number") return;
  mkdirSync(LIMIT_STATE_DIR, { recursive: true });
  const path = join(LIMIT_STATE_DIR, `${id}.json`);
  const previous = readJson(path);
  const now = Date.now();
  if (previous && previous.resetsAt === fiveHour.resets_at && state.lastCallTime > previous.callTime
    && now - previous.seenAt < LIMIT_FRESH_MS) {
    const delta = fiveHour.used_percentage - previous.percentage;
    if (delta >= 0 && delta < 10) {
      appendFileSync(LIMIT_SAMPLES, `${JSON.stringify({ time: now, delta, context: state.context, cold: state.lastCallCold })}\n`);
      const samples = readSamples();
      if (samples.length > 4 * LIMIT_SAMPLE_WINDOW) {
        writeFileSync(LIMIT_SAMPLES, samples.slice(-2 * LIMIT_SAMPLE_WINDOW).map((sample) => JSON.stringify(sample)).join("\n") + "\n");
      }
    }
  }
  writeFileSync(path, JSON.stringify({ percentage: fiveHour.used_percentage, resetsAt: fiveHour.resets_at, callTime: state.lastCallTime, seenAt: now }));
}

/** The estimated share of the 5-hour limit one warm call takes at this context, or null. */
function limitPerCall(context) {
  const warm = readSamples().filter((sample) => !sample.cold).slice(-LIMIT_SAMPLE_WINDOW);
  if (warm.length < LIMIT_MIN_SAMPLES) return null;
  const totalContext = warm.reduce((sum, sample) => sum + sample.context, 0);
  if (!totalContext) return null;
  return (warm.reduce((sum, sample) => sum + sample.delta, 0) / totalContext) * context;
}

const clock = (epochSeconds) => new Date(epochSeconds * 1000).toTimeString().slice(0, 5);
const percent = (value) => `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
const limitColor = (value) => (value >= 90 ? COLOR.red : value >= 70 ? COLOR.yellow : "");

function limitsText(limits) {
  const parts = [];
  const five = limits.five_hour;
  const seven = limits.seven_day;
  if (typeof five?.used_percentage === "number") {
    parts.push(`${limitColor(five.used_percentage)}5h ${percent(five.used_percentage)}${COLOR.reset}` +
      (five.resets_at ? ` ${COLOR.dim}(reset ${clock(five.resets_at)})${COLOR.reset}` : ""));
  }
  if (typeof seven?.used_percentage === "number") {
    parts.push(`${limitColor(seven.used_percentage)}7d ${percent(seven.used_percentage)}${COLOR.reset}`);
  }
  return parts.join(" · ");
}

// ---------------------------------------------------------------- the status line

/**
 * On a subscription (Claude Code sends rate_limits), the limits and what one call takes from them,
 * next to the API value of the tokens. On an API key, the dollars.
 */
async function statuslineMain() {
  const input = await readInput();
  const state = stateFor(input);
  if (!state) { console.log(`${COLOR.dim}sessionkit: no calls yet${COLOR.reset}`); return; }
  const context = `context ${tokens(state.context)}`;

  const limits = input.rate_limits;
  if (limits?.five_hour || limits?.seven_day) {
    try { learnLimit(sessionId(input), limits.five_hour, state); } catch { /* the status line must still print */ }
    const perCall = limitPerCall(state.context);
    const estimate = perCall === null ? "" : ` · ≈ +${perCall < 0.1 ? perCall.toFixed(2) : perCall.toFixed(1)}%/call`;
    const cache = state.warm
      ? `${state.left < SOON_MS ? COLOR.yellow : COLOR.green}cache warm ${minutes(state.left)}${COLOR.reset} ` +
        `${COLOR.dim}(cold: ${usd(state.coldCall)})${COLOR.reset}`
      : `${COLOR.red}cache cold: next call rewrites ${tokens(state.context)} ≈ ${usd(state.coldCall)}${COLOR.reset}`;
    console.log(`${context} · ${usd(state.perCall)}/call · ${limitsText(limits)}${estimate} · ${cache}`);
    return;
  }

  const perCall = `${usd(state.perCall)}/call`;
  if (state.warm) {
    const color = state.left < SOON_MS ? COLOR.yellow : COLOR.green;
    console.log(`${context} · ${perCall} · ${color}cache warm ${minutes(state.left)}${COLOR.reset} ` +
      `${COLOR.dim}(cold: ${usd(state.coldCall)})${COLOR.reset}`);
  } else {
    console.log(`${context} · ${COLOR.red}cache cold: next message ≈ ${usd(state.coldCall)}${COLOR.reset} ` +
      `${COLOR.dim}· cheaper: sessionkit start --session ${sessionId(input).slice(0, 8)}${COLOR.reset}`);
  }
}

/** On --resume or fork, before the first request: Claude Code's own estimate of the cache write. */
function sessionStart(input) {
  if (!["resume", "fork"].includes(input.source) || !input.prompt_cache_likely_expired) return null;
  const cost = input.estimated_cache_write_usd;
  if (!(cost >= WARN_RESUME_ABOVE_USD)) return null;
  const idle = input.seconds_since_last_response ? ` after ${minutes(input.seconds_since_last_response * 1000)}` : "";
  return {
    systemMessage: `sessionkit: the prompt cache has expired${idle}. Your first message writes ` +
      `${tokens(input.context_tokens ?? 0)} tokens to the cache again: about ${usd(cost)}, and every ` +
      `later message re-reads them. Cheaper: exit and run sessionkit start --session ` +
      `${sessionId(input).slice(0, 8)} "your prompt", which starts fresh with only what matters.`,
  };
}

/**
 * Before a message to a session whose cache has gone cold: when writing the context again costs
 * more than the limit, stop the message once. Sending the same session a message again goes
 * through, until the next call makes the cache warm and the check starts over.
 */
function prompt(input) {
  if (!input.transcript_path || !existsSync(input.transcript_path)) return null;
  const state = cacheState(input.transcript_path);
  if (!state || state.warm || !(state.coldCall >= BLOCK_COLD_ABOVE_USD)) return null;
  const id = sessionId(input);
  const ack = join(ACK_DIR, id);
  const marker = `${state.lastCallTime}`;
  if (existsSync(ack) && readFileSync(ack, "utf8") === marker) return null;
  mkdirSync(ACK_DIR, { recursive: true });
  writeFileSync(ack, marker);
  return {
    decision: "block",
    reason: `sessionkit: the prompt cache of this session has expired. This message would write ` +
      `${tokens(state.context)} tokens to the cache again: about ${usd(state.coldCall)}, and every later ` +
      `message re-reads them (${usd(state.perCall)} each). Send the message again to go ahead anyway, ` +
      `or exit and run sessionkit start --session ${id.slice(0, 8)} "your prompt" to start fresh ` +
      `with only what matters.`,
  };
}

async function hookMain(argv) {
  const [event] = argv;
  const input = await readInput();
  let output = null;
  try {
    output = event === "session-start" ? sessionStart(input) : event === "prompt" ? prompt(input) : null;
  } catch {
    output = null;   // a hook must never stop Claude Code because this check failed
  }
  if (output) console.log(JSON.stringify(output));
}

export { hookMain, statuslineMain };
