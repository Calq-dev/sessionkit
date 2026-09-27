#!/usr/bin/env node
// Measure whether jev-start selects the right turns and routes to the right session.
//
// Labels come from code, so a run needs no hand work and can be repeated:
//   A. Turn selection. Cut a session at turn k; the real next prompt is the new task. Plant
//      five turns with a known label at random places that are not forced: the real turn after
//      the prompt (still applies), the first turn of a session in another project (does not),
//      a stated rule and a plain task (rule or not), and one conclusion with an open block and
//      a done block. Measure how often the right plant scores above the wrong one, and how
//      often each passes its threshold. The real turns give the distribution next to it. A
//      second run with a prompt from another project must lower the scores.
//      (Labels from file overlap and shared terms were tried first: most turns change no file,
//      and shared terms scored at chance, so neither was a usable label.)
//   B. Routing. A later prompt of a session, with the cut session in the pool, must route to
//      that session. The first prompt of a session, with that session out of the pool, must
//      route to a new topic.
//
// Results hold ids, turn numbers, scores and labels, never transcript text.
//
// A run costs money. It first runs dry, without network, to estimate the cost, and asks
// before it spends anything. --yes skips the question; --estimate stops after the estimate.
//
// Usage: node eval/measure.mjs [--cuts 30] [--routes 20] [--seed 1] [--yes] [--estimate]

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXCERPT_FLOOR, NEW_TOPIC, ROUTE_ASK, ROUTE_CANDIDATES, ROUTE_CONTINUE, SECTION_FLOOR, SESSION_TAIL, SHORTLIST_FLOOR,
  askNouls, continueSession, pool, readSession, relevanceQuestion, routeToSession, sessionCard, sessionFiles,
  startEstimate, stopEstimate,
} from "../jev-start.mjs";
import { createInterface } from "node:readline";

const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "results");
const POOL_SIZE = 150;
const MIN_TURNS = 6;
const MIN_PROMPT_CHARS = 40;

const argument = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const CUTS = argument("cuts", 30);
const ROUTES = argument("routes", 20);
let seed = argument("seed", 1);

/** A small seeded generator, so a run can be repeated with the same sample. */
function random() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
const pick = (items) => items[Math.floor(random() * items.length)];
const shuffle = (items) => items.map((item) => [random(), item]).sort((a, b) => a[0] - b[0]).map(([, item]) => item);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
};

/** A session as it was at turn k: the earlier turns only, and a summary only if it came earlier. */
function cutSession(session, k) {
  const exchanges = session.exchanges.slice(0, k);
  const changedFiles = new Map();
  for (const exchange of exchanges) for (const file of exchange.files) changedFiles.set(file, exchange.timestamp);
  const end = exchanges.at(-1)?.timestamp ?? session.start;
  const summary = session.summary && session.summary.timestamp < end ? session.summary : null;
  return { ...session, id: `${session.id}@${k}`, exchanges, changedFiles, commands: [], summary, end, cwd: "" };
}

const RULE_PLANT = {
  prompt: "Vanaf nu: schrijf alle commitberichten in het Engels en gebruik nooit emoji.",
  answer: "Begrepen. Ik schrijf commitberichten voortaan in het Engels, zonder emoji.",
};
const TASK_PLANT = {
  prompt: "Draai de tests nog een keer.",
  answer: "Ik heb de tests gedraaid. Ze slagen allemaal.",
};
const OPEN_BLOCK = "Nog open: de migratie voor de nieuwe tabel is nog niet gedraaid. Dat moet jij eerst bevestigen.";
const DONE_BLOCK = "De vertaalbestanden zijn bijgewerkt en de build slaagt.";
const OPEN_PLANT = {
  prompt: "Hoe staat het ervoor?",
  answer: `${DONE_BLOCK}\n\n${OPEN_BLOCK}`,
};

const planted = (turn, timestamp) => ({ ...turn, timestamp, files: new Set(), toolCalls: 0 });
const share = (flags) => (flags.length ? flags.filter(Boolean).length / flags.length : null);
const percentile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : NaN;
};
const spread = (values) => ({ n: values.length, median: median(values), p90: percentile(values, 0.9), max: Math.max(...values) });

/**
 * A cut with five planted turns at random free places: after the first turn and before the
 * last SESSION_TAIL turns, which are forced. Returns the session and where each plant landed.
 */
function plantedCut(session, k, stranger) {
  const exchanges = session.exchanges.slice(0, k);
  const timestamp = exchanges.at(-1).timestamp;
  const plants = {
    related: { ...session.exchanges[k + 1], files: new Set(), toolCalls: 0 },
    unrelated: planted(stranger.exchanges[0], timestamp),
    rule: planted(RULE_PLANT, timestamp),
    task: planted(TASK_PLANT, timestamp),
    open: planted(OPEN_PLANT, timestamp),
  };
  for (const [name, turn] of Object.entries(plants)) {
    const position = 1 + Math.floor(random() * (exchanges.length - SESSION_TAIL));
    exchanges.splice(position, 0, { ...turn, plant: name });
  }
  const cut = cutSession({ ...session, exchanges }, exchanges.length);
  const at = Object.fromEntries(cut.exchanges.map((exchange, i) => [exchange.plant, i]).filter(([name]) => name));
  return { cut, at };
}

async function measureTurns(sessions) {
  const eligible = sessions.filter((session) => session.exchanges.length >= MIN_TURNS);
  const cuts = [];
  for (const session of shuffle(eligible)) {
    const k = Math.floor(session.exchanges.length * (0.5 + random() * 0.3));
    const next = session.exchanges[k];
    const after = session.exchanges[k + 1];
    if (k < 4 || !next || !after || next.prompt.length < MIN_PROMPT_CHARS || next.prompt.startsWith("<")) continue;
    const stranger = pick(sessions.filter((other) => other.cwd !== session.cwd && other.exchanges[0].answer));
    cuts.push({ session, k, stranger });
    if (cuts.length >= CUTS) break;
  }
  process.stderr.write(`turns: ${eligible.length} sessions eligible, ${cuts.length} cuts\n`);
  if (!cuts.length) throw new Error("No cuts: nothing to measure.");

  let tokens = 0;
  const rows = await pool(cuts, async ({ session, k, stranger }) => {
    const { cut, at } = plantedCut(session, k, stranger);
    const prompt = session.exchanges[k].prompt;
    const foreign = pick(sessions.filter((other) => other.cwd !== session.cwd)).exchanges[0].prompt;
    const [real, away] = await Promise.all([continueSession(prompt, cut, {}), continueSession(foreign, cut, {})]);
    tokens += real.tokens + away.tokens;
    const { applies, rules, open, blocks } = real.scores;
    const blockScore = (text) => {
      const i = blocks.findIndex((block) => block.turn === at.open + 1 && block.text === text);
      return i >= 0 ? open[i] : null;
    };
    const plantIndexes = new Set(Object.values(at));
    const realTurns = cut.exchanges.map((_, i) => i).filter((i) => !plantIndexes.has(i));
    const free = (i) => i > 0 && i < cut.exchanges.length - SESSION_TAIL;
    return {
      session: session.id, cut: k, turns: cut.exchanges.length,
      applies: { related: applies[at.related], unrelated: applies[at.unrelated] },
      applies_away: { related: away.scores.applies[at.related], unrelated: away.scores.applies[at.unrelated] },
      rule: { rule: rules[at.rule], task: rules[at.task] },
      open: { open: blockScore(OPEN_BLOCK), done: blockScore(DONE_BLOCK) },
      real: {
        applies: realTurns.filter(free).map((i) => applies[i]),
        applies_away: realTurns.filter(free).map((i) => away.scores.applies[i]),
        rules: realTurns.map((i) => rules[i]),
        open: blocks.map((block, i) => (block.turn - 1 === at.open ? null : open[i])).filter((value) => value !== null),
      },
    };
  });

  const pairs = (key, good, bad) => rows.map((row) => [row[key][good], row[key][bad]]).filter(([g, b]) => g !== null && b !== null);
  const wins = (list) => share(list.map(([g, b]) => g > b));
  const realApplies = rows.flatMap((row) => row.real.applies);
  const realAway = rows.flatMap((row) => row.real.applies_away);
  const realRules = rows.flatMap((row) => row.real.rules);
  const realOpen = rows.flatMap((row) => row.real.open);
  return {
    rows,
    tokens,
    summary: {
      cuts: rows.length,
      applies: {
        related_beats_unrelated: wins(pairs("applies", "related", "unrelated")),
        related_at_floor: share(rows.map((row) => row.applies.related >= EXCERPT_FLOOR)),
        unrelated_at_floor: share(rows.map((row) => row.applies.unrelated >= EXCERPT_FLOOR)),
        related: spread(rows.map((row) => row.applies.related)),
        unrelated: spread(rows.map((row) => row.applies.unrelated)),
        real_turns: spread(realApplies),
        real_kept_at_floor: share(realApplies.map((value) => value >= EXCERPT_FLOOR)),
        foreign_prompt_median_move: median(realAway.map((value, i) => value - realApplies[i])),
        related_with_foreign_prompt: spread(rows.map((row) => row.applies_away.related)),
      },
      rules: {
        rule_beats_task: wins(pairs("rule", "rule", "task")),
        rule_at_floor: share(rows.map((row) => row.rule.rule >= SECTION_FLOOR)),
        task_at_floor: share(rows.map((row) => row.rule.task >= SECTION_FLOOR)),
        rule: spread(rows.map((row) => row.rule.rule)),
        task: spread(rows.map((row) => row.rule.task)),
        real_turns: spread(realRules),
        real_at_floor: share(realRules.map((value) => value >= SECTION_FLOOR)),
      },
      open: {
        open_beats_done: wins(pairs("open", "open", "done")),
        open_at_floor: share(pairs("open", "open", "done").map(([g]) => g >= SECTION_FLOOR)),
        done_at_floor: share(pairs("open", "open", "done").map(([, b]) => b >= SECTION_FLOOR)),
        real_blocks: spread(realOpen),
        real_at_floor: share(realOpen.map((value) => value >= SECTION_FLOOR)),
      },
    },
  };
}

async function firstPass(prompt, pooled) {
  const { probabilities, tokens } = await askNouls({ new_task: prompt },
    pooled.map((session) => relevanceQuestion(sessionCard(session))));
  const scored = pooled.map((session, i) => ({ session, relevance: probabilities[i] }))
    .sort((a, b) => b.relevance - a.relevance);
  return { scored, tokens };
}

async function measureRoutes(sessions) {
  const eligible = shuffle(sessions.filter((session) => session.exchanges.length >= 4));
  const items = [];
  for (const session of eligible) {
    if (items.length >= ROUTES * 2) break;
    const k = 2 + Math.floor(random() * (session.exchanges.length - 2));
    const later = session.exchanges[k].prompt;
    const first = session.exchanges[0].prompt;
    if (later.length >= MIN_PROMPT_CHARS && !later.startsWith("<")) {
      items.push({ kind: "continue", session, prompt: later, pool: [...sessions.filter((s) => s !== session), cutSession(session, k)], expected: `${session.id}@${k}` });
    }
    if (first.length >= MIN_PROMPT_CHARS && !first.startsWith("<")) {
      items.push({ kind: "new", session, prompt: first, pool: sessions.filter((s) => s !== session), expected: NEW_TOPIC });
    }
  }
  process.stderr.write(`routes: ${items.length} items\n`);
  if (!items.length) throw new Error("No routing items: nothing to measure.");

  let tokens = 0;
  const rows = await pool(items, async (item) => {
    const first = await firstPass(item.prompt, item.pool);
    const candidates = first.scored.filter((c) => c.relevance >= SHORTLIST_FLOOR).slice(0, ROUTE_CANDIDATES);
    const route = candidates.length
      ? await routeToSession(item.prompt, candidates, {})
      : { session: null, probability: 1, tokens: 0 };
    tokens += first.tokens + route.tokens;
    const answer = route.session ? route.session.id : NEW_TOPIC;
    const action = !route.session ? "search" : route.probability >= ROUTE_CONTINUE ? "continue" : route.probability >= ROUTE_ASK ? "ask" : "search";
    return {
      kind: item.kind, session: item.session.id, expected: item.expected, answer,
      probability: route.probability, action,
      expected_in_candidates: item.kind === "new" || candidates.some((c) => c.session.id === item.expected),
    };
  });

  const summarize = (kind) => {
    const set = rows.filter((row) => row.kind === kind);
    return {
      items: set.length,
      right_answer: set.filter((row) => row.answer === row.expected).length,
      actions: Object.fromEntries(["continue", "ask", "search"].map((a) => [a, set.filter((row) => row.action === a).length])),
      auto_continue_right: set.filter((row) => row.action === "continue" && row.answer === row.expected).length,
      auto_continue_wrong: set.filter((row) => row.action === "continue" && row.answer !== row.expected).length,
      expected_in_candidates: set.filter((row) => row.expected_in_candidates).length,
    };
  };
  return { rows, tokens, summary: { continue: summarize("continue"), new: summarize("new") } };
}

const flag = (name) => process.argv.includes(`--${name}`);

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((resolve) => readline.question(question, resolve));
  readline.close();
  return /^y/i.test(answer.trim());
}

async function measureAll(sessions) {
  const turns = await measureTurns(sessions);
  const routes = ROUTES > 0 ? await measureRoutes(sessions) : { rows: [], tokens: 0, summary: null };
  return { turns, routes };
}

async function main() {
  const files = sessionFiles(true, POOL_SIZE);
  const sessions = (await pool(files, (file) => readSession(file.path)))
    .filter((session) => session.exchanges.length > 0);
  process.stderr.write(`loaded ${sessions.length} sessions from ${files.length} files\n`);
  if (!sessions.length) throw new Error("No sessions loaded.");

  // The dry run draws the same sample as the real one: the seed goes back afterwards.
  const startSeed = seed;
  startEstimate();
  await measureAll(sessions);
  const cost = stopEstimate();
  seed = startSeed;
  process.stderr.write(`estimate: ${cost.requests} requests, ${cost.chars.toLocaleString("en")} characters, ` +
    `at most ${cost.tokens.toLocaleString("en")} tokens, at most $${cost.cost_usd.toFixed(2)}\n`);
  if (flag("estimate")) return;
  if (!flag("yes") && !(await confirm(`Spend at most $${cost.cost_usd.toFixed(2)} on this run? [y/N] `))) {
    process.stderr.write("measure: stopped before spending anything.\n");
    process.exit(2);
  }

  const { turns, routes } = await measureAll(sessions);
  const tokens = turns.tokens + routes.tokens;
  const result = {
    run: new Date().toISOString(),
    seed: argument("seed", 1),
    thresholds: { EXCERPT_FLOOR, ROUTE_ASK, ROUTE_CONTINUE, SECTION_FLOOR, SHORTLIST_FLOOR },
    tokens,
    cost_usd: (tokens / 1e6) * 0.042,
    turns: turns.summary,
    routes: routes.summary,
    rows: { turns: turns.rows, routes: routes.rows },
  };
  mkdirSync(RESULTS_DIR, { recursive: true });
  const file = join(RESULTS_DIR, `${result.run.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ turns: result.turns, routes: result.routes, tokens, cost_usd: result.cost_usd, file }, null, 2));
}

main().catch((error) => {
  process.stderr.write(`measure: ${error.message}\n`);
  process.exit(1);
});
