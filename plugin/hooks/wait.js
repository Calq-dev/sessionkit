// sessionkit against waiting in Bash. A prompt cache lives five minutes after the last model
// call; a Bash call that waits longer lets the loop's whole context go cold, and the next call
// writes all of it again. In the transcripts here over 30 days, 390 such rebuilds cost $582
// (5.8% of everything); 194 followed a Bash call, and of those 118 were poll loops the agent had
// written itself (`until grep -q '^exit' …; do sleep`, `for i in $(seq 1 115)`), many ending at
// the Bash timeout of ten minutes, and 44 were test suites run in the foreground.
//
// A poll loop in the foreground is refused with the number that matters, the cold write of the
// loop's context; the agent chooses again, with run_in_background or Monitor. A foreground call
// that ran longer than the cache lives gets one line after it with the same number. The
// context size of each loop comes from its own requests. `sessionkit hook wait-cost` words the
// lines: prices live there.
//
// sessionkit setup writes this file with the path of sessionkit on this machine.

const SESSIONKIT = "__SESSIONKIT__";
const TIMEOUT_MS = 10_000;
export const LONG_MS = 5 * 60_000; // the cache's life: a call this long comes back to a cold cache

const contexts = new Map(); // loop → { model, context }

// A loop that sleeps, or a sleep that outlives a cache on its own.
const LOOP = /\b(while|until|for)\b[^\n]*\bdo\b[\s\S]*?\bsleep\b|\b(while|until|for)\b[\s\S]*?\bsleep\b[\s\S]*?\bdone\b/;
const LONG_SLEEP = /\bsleep\s+(\d+)(m|h)?\b/g;

/** Whether a command waits in the foreground instead of doing work. */
export function polls(command) {
  if (typeof command !== "string") return false;
  if (LOOP.test(command)) return true;
  for (const [, count, unit] of command.matchAll(LONG_SLEEP)) {
    const seconds = Number(count) * (unit === "m" ? 60 : unit === "h" ? 3600 : 1);
    if (seconds >= 60) return true;
  }
  return false;
}

const loopOf = (agentId) => agentId ?? "main";

/** What a loop's last request said its context was. */
export function stepped(agentId, model, usage) {
  if (!usage) return;
  const context = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  contexts.set(loopOf(agentId), { model, context });
}

export function reset() {
  contexts.clear();
}

const FALLBACK = {
  poll: "sessionkit: this command waits in Bash; five minutes after your last model call the cache of your whole context expires. " +
    "Run the long step with run_in_background, or wait for a condition with Monitor, and do other work meanwhile.",
  long: "sessionkit: that command ran longer than the cache lives, so this call wrote your whole context again. " +
    "Next time run a command that long with run_in_background and keep working.",
};

/** The line for a wait, worded by sessionkit with the price; the plain line when that fails. */
export async function line($, kind, agentId, seconds) {
  const { model, context } = contexts.get(loopOf(agentId)) ?? {};
  try {
    const input = { session_id: await $.session.id(), kind, model, context, seconds };
    const run = await $.process.run([SESSIONKIT, "hook", "wait-cost"], { stdin: JSON.stringify(input), timeoutMs: TIMEOUT_MS });
    const { text } = JSON.parse(run.stdout);
    return text || FALLBACK[kind];
  } catch {
    return FALLBACK[kind];
  }
}

/** @type {import('claude-code').Register} */
export const register = (on) => {
  // Every step; the matcher only sets this hook apart from the plugin's others on turn.step.
  on("turn.step", { model: /./ }, async function* ($, event, next) {
    for await (const chunk of next(event)) {
      if (chunk.kind === "stop") stepped(event.agentId, event.model, chunk.usage);
      yield chunk;
    }
  });

  on("tool.call", { tool: "Bash" }, async ($, event, next) => {
    if (!event.run_in_background && polls(event.command)) return { deny: await line($, "poll", event.agentId) };
    const started = Date.now();
    const result = await next(event);
    const ms = Date.now() - started;
    if (event.run_in_background || ms < LONG_MS || "deny" in result) return result;
    const note = await line($, "long", event.agentId, Math.round(ms / 1000));
    return { ...result, context: [...(result.context ?? []), note] };
  });
};
