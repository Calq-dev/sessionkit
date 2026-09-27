// sessionkit usage — where the tokens and the money go in your Claude Code sessions.
//
// Reads the transcripts under ~/.claude/projects, main sessions and their subagents, and adds up
// the usage that every API call records: uncached input, cache reads, cache writes (5 minutes and
// 1 hour) and output. Everything stays on this machine; no model is asked anything.
//
// Costs are API-equivalent: token counts times the published per-token prices. With a
// subscription you pay a flat fee instead, so read them as the value of what you used.
//
// Claude Code's own "cost-state" per session is not used: it counts per process, so a resumed
// session starts again, and totals from it came out both too low and too high.

import { createReadStream, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const HOME = homedir();
const CACHE_TTL_MS = 5 * 60 * 1000;
const REBUILD_MIN_TOKENS = 20000;    // a cache write this large after a pause rebuilds the context
const FRESH_CONTEXT_TOKENS = 15000;  // about what sessionkit start hands a new session
const RESTART_MIN_CONTEXT = 150000;
const RESTART_RECENT_DAYS = 14;
const CONCURRENCY = 8;

/**
 * USD per million tokens, from the Claude API model table (cached 2026-06-24). Cache writes cost
 * 1.25x input for 5 minutes and 2x for 1 hour; cache reads 0.1x input unless a model sets its own.
 * Fast mode costs twice the standard price.
 */
const PRICES = {
  "claude-fable-5-1": { input: 10, output: 50, read: 0.25 },
  "claude-mythos-5-1": { input: 10, output: 50, read: 0.25 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20, read: 0.2 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

const USAGE = `Usage: sessionkit usage [options]

Shows where the tokens and the money go in your Claude Code sessions: by kind of token, by
model, main sessions against subagents, by project, the largest sessions, cold cache rebuilds,
and sessions that are cheaper to restart than to continue. Local only.

Options:
  --days <n>        only API calls from the last n days (default: all)
  --project <text>  only projects whose folder contains this text
  --top <n>         rows per table (default 10)
  --json            print the numbers as JSON
  -h, --help        show this help`;

function parseArguments(argv) {
  const options = { days: null, project: "", top: 10, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--days") options.days = Number(argv[++i]);
    else if (arg === "--project") options.project = (argv[++i] ?? "").toLowerCase();
    else if (arg === "--top") options.top = Math.max(1, Number(argv[++i]) || 10);
    else if (arg === "--json") options.json = true;
    else if (arg === "-h" || arg === "--help") { console.log(USAGE); process.exit(0); }
    else { console.error(`sessionkit usage: unknown option ${arg}\n\n${USAGE}`); process.exit(2); }
  }
  return options;
}

// ---------------------------------------------------------------- prices

function priceOf(model) {
  return PRICES[model] ?? PRICES[model?.replace(/-\d{8}$/, "")] ?? null;
}

const readPrice = (price) => price.read ?? price.input * 0.1;

/** The cost of one call in USD, split by kind of token; null parts when the model has no price. */
function costOf(call) {
  const price = priceOf(call.model);
  if (!price) return null;
  const factor = call.fast ? 2 : 1;
  const part = (tokens, perMillion) => (tokens * perMillion * factor) / 1e6;
  return {
    input: part(call.input, price.input),
    read: part(call.read, readPrice(price)),
    write: part(call.write5m, price.input * 1.25) + part(call.write1h, price.input * 2),
    output: part(call.output, price.output),
  };
}

// ---------------------------------------------------------------- reading

/** The project a folder belongs to: its path under home, without a worktree suffix. */
function projectOf(cwd, folder) {
  if (!cwd) return folder;
  const root = cwd.replace(/\/\.claude\/worktrees\/.*$/, "").replace(/\/\.worktrees\/.*$/, "");
  return root.startsWith(`${HOME}/`) ? `~/${root.slice(HOME.length + 1)}` : root;
}

/** Every transcript: main sessions, and the subagents stored beside them. */
function transcriptFiles() {
  const files = [];
  for (const folder of readdirSync(PROJECTS_DIR)) {
    const dir = join(PROJECTS_DIR, folder);
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push({ path: join(dir, entry.name), folder, session: entry.name.slice(0, -6), subagent: false });
      } else if (entry.isDirectory()) {
        const subagents = join(dir, entry.name, "subagents");
        if (!existsSync(subagents)) continue;
        for (const name of readdirSync(subagents).filter((file) => file.endsWith(".jsonl"))) {
          files.push({ path: join(subagents, name), folder, session: entry.name, subagent: true });
        }
      }
    }
  }
  return files;
}

/**
 * The API calls in one transcript. A response with several content blocks is written as several
 * lines with the same usage, and a forked session copies earlier calls into its own file, so
 * every call is counted once by its message id, across all files.
 */
async function readCalls(file, seen) {
  const calls = [];
  let title = "", cwd = "";
  const lines = createInterface({ input: createReadStream(file.path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"usage"') && !line.includes('"ai-title"')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "ai-title" && entry.aiTitle) title = entry.aiTitle;
    if (entry.type !== "assistant") continue;
    if (entry.cwd && !cwd) cwd = entry.cwd;
    const message = entry.message ?? {};
    const usage = message.usage;
    const id = message.id ?? entry.requestId;
    // Claude Code writes "<synthetic>" messages itself; they are not API calls.
    if (!usage || !id || seen.has(id) || message.model === "<synthetic>") continue;
    seen.add(id);
    const write = usage.cache_creation_input_tokens ?? 0;
    const split = usage.cache_creation ?? {};
    const write1h = split.ephemeral_1h_input_tokens ?? 0;
    calls.push({
      time: Date.parse(entry.timestamp),
      model: message.model,
      fast: usage.speed === "fast",
      input: usage.input_tokens ?? 0,
      read: usage.cache_read_input_tokens ?? 0,
      write5m: split.ephemeral_5m_input_tokens ?? write - write1h,
      write1h,
      output: usage.output_tokens ?? 0,
    });
  }
  return { ...file, calls, title, cwd };
}

async function pool(items, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await task(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------- adding up

const KINDS = ["read", "write", "output", "input"];
const emptyTotals = () => ({ calls: 0, tokens: { input: 0, read: 0, write: 0, output: 0 }, cost: { input: 0, read: 0, write: 0, output: 0 }, unpriced: 0 });

function add(totals, call) {
  totals.calls++;
  totals.tokens.input += call.input;
  totals.tokens.read += call.read;
  totals.tokens.write += call.write5m + call.write1h;
  totals.tokens.output += call.output;
  const cost = costOf(call);
  if (!cost) { totals.unpriced += call.input + call.read + call.write5m + call.write1h + call.output; return; }
  for (const kind of KINDS) totals.cost[kind] += cost[kind];
}

const sum = (parts) => KINDS.reduce((total, kind) => total + parts[kind], 0);
const contextOf = (call) => call.input + call.read + call.write5m + call.write1h;

/**
 * Cold cache rebuilds in a main session: a call after a pause longer than the cache lifetime
 * that writes a large context and reads less than it writes. A heuristic: a changed prompt
 * prefix also rewrites the cache without a pause.
 */
function rebuildsOf(calls) {
  const rebuilds = [];
  for (let i = 1; i < calls.length; i++) {
    const call = calls[i];
    const gap = call.time - calls[i - 1].time;
    const write = call.write5m + call.write1h;
    if (gap > CACHE_TTL_MS && write >= REBUILD_MIN_TOKENS && write > call.read) {
      const cost = costOf(call);
      rebuilds.push({ gap, tokens: write, cost: cost ? cost.write : 0 });
    }
  }
  return rebuilds;
}

function summarize(transcripts, options) {
  const since = options.days ? Date.now() - options.days * 86400000 : 0;
  const total = emptyTotals();
  const byModel = new Map();
  const byKind = { main: emptyTotals(), subagent: emptyTotals() };
  const byProject = new Map();
  const sessions = new Map();
  const unpricedModels = new Set();

  for (const transcript of transcripts) {
    const project = projectOf(transcript.cwd, transcript.folder);
    if (options.project && !`${project} ${transcript.folder}`.toLowerCase().includes(options.project)) continue;
    const calls = transcript.calls.filter((call) => call.time >= since).sort((a, b) => a.time - b.time);
    if (!calls.length) continue;
    const key = transcript.session;
    if (!sessions.has(key)) sessions.set(key, { id: key, project, title: "", main: emptyTotals(), subagents: emptyTotals(), calls: [], subagentFiles: 0 });
    const session = sessions.get(key);
    if (!transcript.subagent) { session.title = transcript.title || session.title; session.project = project; session.calls = calls; }
    else session.subagentFiles++;
    if (!byProject.has(project)) byProject.set(project, emptyTotals());

    for (const call of calls) {
      add(total, call);
      add(byKind[transcript.subagent ? "subagent" : "main"], call);
      add(byProject.get(project), call);
      add(transcript.subagent ? session.subagents : session.main, call);
      const model = call.model ?? "unknown";
      if (!byModel.has(model)) byModel.set(model, emptyTotals());
      add(byModel.get(model), call);
      if (!priceOf(call.model)) unpricedModels.add(model);
    }
  }

  const recent = Date.now() - RESTART_RECENT_DAYS * 86400000;
  const sessionRows = [...sessions.values()].map((session) => {
    const { calls } = session;
    const rebuilds = rebuildsOf(calls);
    const last = calls.at(-1);
    const price = last ? priceOf(last.model) : null;
    const lastContext = last ? contextOf(last) : 0;
    return {
      id: session.id,
      project: session.project,
      title: session.title,
      cost: sum(session.main.cost) + sum(session.subagents.cost),
      subagentCost: sum(session.subagents.cost),
      calls: session.main.calls + session.subagents.calls,
      averageContext: calls.length ? calls.reduce((s, call) => s + contextOf(call), 0) / calls.length : 0,
      lastContext,
      lastActive: last?.time ?? 0,
      rebuilds: rebuilds.length,
      rebuildCost: rebuilds.reduce((s, r) => s + r.cost, 0),
      // What one more call costs in cache reads now, against a fresh start of about 15k tokens.
      perCallNow: price ? (lastContext * readPrice(price)) / 1e6 : null,
      perCallFresh: price ? (FRESH_CONTEXT_TOKENS * readPrice(price)) / 1e6 : null,
      // What a cold --resume writes once, at the 1-hour cache price Claude Code uses.
      coldResume: price ? (lastContext * price.input * 2) / 1e6 : null,
    };
  });

  const allRebuilds = [...sessions.values()].flatMap((session) => rebuildsOf(session.calls));
  return {
    window: options.days ? `last ${options.days} days` : "all time",
    transcripts: transcripts.length,
    total,
    byModel: [...byModel.entries()].map(([model, totals]) => ({ model, ...totals })).sort((a, b) => sum(b.cost) - sum(a.cost)),
    byKind,
    byProject: [...byProject.entries()].map(([project, totals]) => ({ project, ...totals })).sort((a, b) => sum(b.cost) - sum(a.cost)),
    sessions: sessionRows.sort((a, b) => b.cost - a.cost),
    rebuilds: {
      count: allRebuilds.length,
      tokens: allRebuilds.reduce((s, r) => s + r.tokens, 0),
      cost: allRebuilds.reduce((s, r) => s + r.cost, 0),
      afterAnHour: allRebuilds.filter((r) => r.gap > 3600000).length,
    },
    restartCandidates: sessionRows
      .filter((row) => row.lastActive >= recent && row.lastContext >= RESTART_MIN_CONTEXT && row.perCallNow !== null)
      .sort((a, b) => b.perCallNow - a.perCallNow),
    unpricedModels: [...unpricedModels],
  };
}

// ---------------------------------------------------------------- printing

const usd = (value) => (value >= 100 ? `$${Math.round(value).toLocaleString("en")}` : `$${value.toFixed(2)}`);
const tokens = (value) => (value >= 1e9 ? `${(value / 1e9).toFixed(2)}B` : value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${Math.round(value / 1e3)}K` : `${value}`);
const share = (part, whole) => (whole ? `${Math.round((100 * part) / whole)}%` : "-");
const day = (time) => (time ? new Date(time).toISOString().slice(0, 10) : "");
const pad = (text, width) => String(text).slice(0, width).padEnd(width);
const lpad = (text, width) => String(text).padStart(width);

function table(title, header, rows) {
  const lines = [``, title, ``, header, "-".repeat(header.length), ...rows];
  return lines.join("\n");
}

function render(report, options) {
  const totalCost = sum(report.total.cost);
  const out = [];
  out.push(`sessionkit usage — ${report.window}: ${report.transcripts.toLocaleString("en")} transcripts, ` +
    `${report.total.calls.toLocaleString("en")} API calls, ${usd(totalCost)} API-equivalent`);
  out.push("Prices are the published per-token prices. With a subscription you pay a flat fee instead.");
  if (report.unpricedModels.length) {
    out.push(`No price known for ${report.unpricedModels.join(", ")}: ${tokens(report.total.unpriced)} tokens left out of the costs.`);
  }

  const names = { read: "cache reads", write: "cache writes", output: "output", input: "uncached input" };
  out.push(table("Where it goes", `${pad("kind", 16)}${lpad("tokens", 10)}${lpad("cost", 11)}${lpad("share", 7)}`,
    KINDS.map((kind) => `${pad(names[kind], 16)}${lpad(tokens(report.total.tokens[kind]), 10)}` +
      `${lpad(usd(report.total.cost[kind]), 11)}${lpad(share(report.total.cost[kind], totalCost), 7)}`)));

  out.push(table("By model", `${pad("model", 26)}${lpad("calls", 9)}${lpad("cost", 11)}${lpad("share", 7)}`,
    report.byModel.slice(0, options.top).map((row) => `${pad(row.model, 26)}${lpad(row.calls.toLocaleString("en"), 9)}` +
      `${lpad(priceOf(row.model) ? usd(sum(row.cost)) : "no price", 11)}${lpad(share(sum(row.cost), totalCost), 7)}`)));

  out.push(table("Main sessions and subagents", `${pad("", 14)}${lpad("calls", 9)}${lpad("tokens", 10)}${lpad("cost", 11)}${lpad("share", 7)}`,
    ["main", "subagent"].map((kind) => {
      const row = report.byKind[kind];
      const all = row.tokens.input + row.tokens.read + row.tokens.write + row.tokens.output;
      return `${pad(kind === "main" ? "main sessions" : "subagents", 14)}${lpad(row.calls.toLocaleString("en"), 9)}` +
        `${lpad(tokens(all), 10)}${lpad(usd(sum(row.cost)), 11)}${lpad(share(sum(row.cost), totalCost), 7)}`;
    })));

  out.push(table("By project", `${pad("project", 44)}${lpad("calls", 9)}${lpad("cost", 11)}${lpad("share", 7)}`,
    report.byProject.slice(0, options.top).map((row) => `${pad(row.project, 44)}${lpad(row.calls.toLocaleString("en"), 9)}` +
      `${lpad(usd(sum(row.cost)), 11)}${lpad(share(sum(row.cost), totalCost), 7)}`)));

  out.push(table("Largest sessions (cost includes their subagents)",
    `${lpad("cost", 9)}${lpad("subagents", 10)}${lpad("calls", 8)}${lpad("avg ctx", 9)}${lpad("cold", 6)}  ${pad("last", 11)}${pad("title", 38)}id`,
    report.sessions.slice(0, options.top).map((row) => `${lpad(usd(row.cost), 9)}${lpad(share(row.subagentCost, row.cost), 10)}` +
      `${lpad(row.calls.toLocaleString("en"), 8)}${lpad(tokens(row.averageContext), 9)}${lpad(row.rebuilds, 6)}  ` +
      `${pad(day(row.lastActive), 11)}${pad(row.title || row.project, 37)} ${row.id.slice(0, 8)}`)));

  const r = report.rebuilds;
  out.push("", "Cold cache rebuilds",
    "", `${r.count} calls wrote the context again after a pause of more than 5 minutes: ${tokens(r.tokens)} tokens, ` +
    `${usd(r.cost)} (${share(r.cost, totalCost)} of the total). ${r.afterAnHour} came after more than an hour.`,
    "A heuristic: a large cache write after a pause, larger than the cache read in the same call.");

  if (report.restartCandidates.length) {
    out.push(table(`Cheaper to restart: active in the last ${RESTART_RECENT_DAYS} days, last context above ${tokens(RESTART_MIN_CONTEXT)}`,
      `${lpad("context", 9)}${lpad("per call", 10)}${lpad("fresh", 8)}${lpad("cold resume", 13)}  ${pad("title", 38)}command`,
      report.restartCandidates.slice(0, options.top).map((row) => `${lpad(tokens(row.lastContext), 9)}` +
        `${lpad(`$${row.perCallNow.toFixed(3)}`, 10)}${lpad(`$${row.perCallFresh.toFixed(3)}`, 8)}${lpad(usd(row.coldResume), 13)}  ` +
        `${pad(row.title || row.project, 37)} sessionkit start --session ${row.id.slice(0, 8)} "…"`)));
    out.push("", "Per call: the cache reads of one more call at the current context. Fresh: the same after a",
      `start with about ${tokens(FRESH_CONTEXT_TOKENS)} of context. Cold resume: the one-time cache write of a --resume after a pause.`);
  }
  return out.join("\n");
}

async function usageMain(argv) {
  const options = parseArguments(argv);
  const files = transcriptFiles();
  if (!files.length) throw new Error(`No transcripts found in ${PROJECTS_DIR}.`);
  const seen = new Set();
  // Main sessions first, so a call copied into a subagent file keeps its main-session owner.
  const transcripts = [];
  for (const batch of [files.filter((file) => !file.subagent), files.filter((file) => file.subagent)]) {
    transcripts.push(...(await pool(batch, (file) => readCalls(file, seen))));
  }
  const report = summarize(transcripts, options);
  if (!report.total.calls) throw new Error("No API calls found for these options.");
  console.log(options.json ? JSON.stringify(report, null, 2) : render(report, options));
}

export { usageMain, priceOf, costOf };
