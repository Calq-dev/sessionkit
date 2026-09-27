// sessionkit statusline and sessionkit hook — show in Claude Code what the prompt cache costs.
//
// Claude Code does not show that a session with 800k tokens of context re-reads all of them on
// every call, or that the first call after an idle hour writes them all again. These commands do:
//
//   statusline           context, cost per call, and how long the cache stays warm
//   hook session-start   on --resume: what the first request will cost when the cache is cold
//   hook prompt          before a message to a cold, expensive session: stop it once and say why
//
// Everything here reaches the user only (the status line, systemMessage, a block reason). Nothing
// is added to Claude's context, so the checks cost no tokens.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { cacheState } from "./cache.mjs";
import { priceOf } from "./usage.mjs";

const setting = (name) => process.env[`SESSIONKIT_${name}`];
const WARN_RESUME_ABOVE_USD = Number(setting("WARN_RESUME_ABOVE") ?? 1);
const BLOCK_COLD_ABOVE_USD = Number(setting("BLOCK_COLD_ABOVE") ?? 2);
const ACK_DIR = join(homedir(), ".cache", "sessionkit", "cold-ack");
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
    perCall: (context * (price.read ?? price.input * 0.1) * factor) / 1e6,
    coldCall: (context * price.input * writeFactor * factor) / 1e6,
  };
}

async function statuslineMain() {
  const input = await readInput();
  const state = stateFor(input);
  if (!state) { console.log(`${COLOR.dim}sessionkit: no calls yet${COLOR.reset}`); return; }
  const context = `ctx ${tokens(state.context)}`;
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
