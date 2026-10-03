// sessionkit's architect: a repository onboarded with /sessionkit:architecture onboard has an
// architect, the agent type sessionkit:architect, with its memory in ARCHITECTURE.md. Each plan
// the coding agent presents and each Edit or Write it makes goes, after it is done and without
// waiting, to `sessionkit hook architect-check`, where Jev reads what the change does to the
// architecture in the memory. Ordinary work stops there. A change Jev finds architectural wakes
// the architect in the background, with the change but without the coding agent's reasoning; its
// advice arrives in the context of the loop that made the change, as a line the model reads. When
// the architect finds a decision or drift, the person is asked whether to follow its advice, take
// it as a decision, or discuss it first. A decision taken is recorded in the memory by the
// architect when the main turn ends.
//
// A plugin's hooks do not see the tool calls of an agent the plugin spawned itself, so reviews run
// as sessionkit:architect-review: the same instructions, registered at session start with tools
// that only read, and not offered to the model. An architect the model starts, from the
// architecture skill, is held to ARCHITECTURE.md and docs/adr/ by the tool.call hook below.
//
// In a git repository without an onboarded memory, the first answer of a session is followed by
// one question: onboard an architect now, not now (asked again next session), or never for this
// repository, which `sessionkit hook architect-decline` keeps in ~/.config/sessionkit/architect.json.
//
// One review runs at a time; changes that come in meanwhile wait and go together in the next.
// The option architect sets
// advise (the default), shadow (Jev's reading is logged in ~/.cache/sessionkit/architect-checks.jsonl,
// nothing wakes) or off. Without the memory, or without a TypeSafe key at hand, nothing is asked.
//
// sessionkit setup writes this file with the path of sessionkit on this machine.

const SESSIONKIT = "__SESSIONKIT__";
const TIMEOUT_MS = 30_000;
const ARCHITECT = "sessionkit:architect";
const REVIEWER = "sessionkit:architect-review";
const REVIEW_TOOLS = ["Read", "Grep", "Glob", "Bash", "Skill"];
const PREFIX = "sessionkit architect";

const ONBOARD = "Onboard now";
const NOT_NOW = "Not now";
const NEVER = "Never for this project";

const FOLLOW = "Follow the advice";
const DECIDE = "Take it as a decision";
const DISCUSS = "Discuss first";

const architects = new Set(); // architects the model started, from the architecture skill
const runs = new Map(); // agent id of a run this plugin started → { kind, items }
const waiting = []; // reviews that came in while one ran
const decisions = []; // { root, text } of decisions the person took, for the architect to record
const earlier = []; // what the architect told the coding agent this session
let running = false;
let offered = false;

const reason = (error) => (error instanceof Error ? error.message : String(error));

/** The change a tool call made, as the classifier reads it, or null for one that changed nothing. */
function changeOf(tool, event, result) {
  const done = result.result;
  if (!done || done.staged) return null;
  if (tool === "ExitPlanMode") return done.plan ? { kind: "plan", file: "", change: done.plan } : null;
  const patch = done.gitDiff?.patch ?? (done.structuredPatch ?? []).flatMap((hunk) => hunk.lines).join("\n");
  if (tool === "Write" && done.type === "create") return { kind: "create", file: event.file_path, change: done.content };
  return patch ? { kind: "edit", file: event.file_path, change: patch } : null;
}

/** May an architect write this file? Only its memory. */
const allowed = (path) => /(^|\/)ARCHITECTURE\.md$/.test(path) || /(^|\/)docs\/adr\/[^/]+$/.test(path);

/** The review agent: the architect's own instructions, from the same file, with tools that only read. */
async function registerReviewer($) {
  const text = await $.fs.read(`${$.plugin.root}/agents/architect.md`);
  await $.agent.register({
    name: "architect-review",
    description: "The architect, read-only, for the reviews sessionkit's hooks start.",
    prompt: text.replace(/^---\n[\s\S]*?\n---\n/, ""),
    tools: REVIEW_TOOLS,
    model: "sonnet",
  });
}

async function classify($, change, loop, options) {
  try {
    const input = { session_id: await $.session.id(), cwd: await $.session.cwd(), ...change, earlier };
    const run = await $.process.run([SESSIONKIT, "hook", "architect-check"], { stdin: JSON.stringify(input), timeoutMs: TIMEOUT_MS });
    const check = JSON.parse(run.stdout);
    if (!check.wake || options?.architect === "shadow") return;
    await review($, { brief: check.brief, loop, file: change.file, root: check.root });
  } catch (error) {
    $.ui.log(`${PREFIX}: change not checked (${reason(error)})`);
  }
}

async function spawn($, kind, items, prompt) {
  running = true;
  try {
    const subagentType = kind === "review" ? REVIEWER : ARCHITECT;
    const { agentId, deny } = await $.agent.spawn({ subagentType, description: `Architect ${kind}`, prompt });
    if (!agentId) throw new Error(deny ?? "not started");
    runs.set(agentId, { kind, items });
  } catch (error) {
    running = false;
    $.ui.log(`${PREFIX}: ${kind} not started (${reason(error)})`);
  }
}

async function review($, item) {
  if (running) return void waiting.push(item);
  await spawn($, "review", [item], item.brief);
}

/** After a run: the next waiting reviews together, or else the decisions to record. */
export async function after($, mainIdle) {
  if (running) return;
  if (waiting.length > 0) {
    const items = waiting.splice(0);
    const prompt = items.length === 1 ? items[0].brief
      : `Several changes came in while you were reviewing; review them together.\n\n${items.map((i) => i.brief).join("\n---\n\n")}`;
    return spawn($, "review", items, prompt);
  }
  if (mainIdle && decisions.length > 0) {
    const root = decisions[0].root;
    const taken = decisions.filter((d) => d.root === root);
    for (const d of taken) decisions.splice(decisions.indexOf(d), 1);
    await spawn($, "record", [], `Record. Repository: ${root}. Decisions:\n${taken.map((d) => `- ${d.text}`).join("\n")}`);
  }
}

/** The architect's answer: its verdict, what it says, and its question for the person. */
function parse(answer) {
  const lines = String(answer ?? "").replace(/```/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  const verdict = lines.map((l) => l.match(/^VERDICT:\s*([A-Z_]+)/)?.[1]).find(Boolean) ?? null;
  const question = lines.map((l) => l.match(/^QUESTION:\s*(.+)/)?.[1]).find(Boolean) ?? null;
  const body = lines.filter((l) => !/^(VERDICT|QUESTION):/.test(l)).join("\n");
  return { verdict, question, body };
}

export async function deliver($, items, answer) {
  const { verdict, question, body } = parse(answer);
  const where = items.map((i) => i.file || "the plan").join(", ");
  if (!verdict || verdict === "NO_CONCERN" || !body) return void $.ui.log(`${PREFIX}: no concern (${where})`);
  earlier.push(body.split("\n")[0]);
  let text = `${PREFIX} (${verdict}, on ${where}): ${body}`;
  if ((verdict === "DECISION" || verdict === "DRIFT") && question) {
    let choice = null;
    try {
      choice = await $.ui.ask(`Architect: ${question}`, { options: [FOLLOW, DECIDE, DISCUSS], header: "Architect" });
    } catch {
      // Dismissed, or nobody to ask: the advice goes in as it is.
    }
    if (choice === FOLLOW) text += "\nThe person chose to follow the architect's recommendation.";
    if (choice === DECIDE) {
      text += "\nThe person takes this as an intended architectural decision: go on. The architect records it in ARCHITECTURE.md when the turn ends.";
      decisions.push({ root: items[0].root, text: `${where}: ${body.split("\n")[0]}` });
    }
    if (choice === DISCUSS) text += "\nThe person wants to discuss this before you go on: finish the current step, then stop and put the architect's concern and the options to the person.";
  }
  const loops = [...new Set(items.map((i) => i.loop))];
  for (const loop of loops) {
    const message = { type: "user", content: [{ type: "text", text }] };
    // A subagent that has ended takes no rows; the main conversation does.
    await $.session.append({ message, ...(loop ? { agentId: loop } : {}) })
      .catch(() => (loop ? $.session.append({ message }) : undefined))
      .catch((error) => $.ui.log(`${PREFIX}: advice not delivered (${reason(error)})`));
  }
}

/** Offer an architect to a repository that has none and did not decline one; once per session. */
export async function offer($) {
  try {
    const run = await $.process.run([SESSIONKIT, "hook", "architect-offer"], { stdin: JSON.stringify({ cwd: await $.session.cwd() }), timeoutMs: TIMEOUT_MS });
    const check = JSON.parse(run.stdout);
    if (!check.ask) return;
    let choice;
    try {
      choice = await $.ui.ask(check.question, { options: [ONBOARD, NOT_NOW, NEVER], header: "Architect" });
    } catch {
      return; // dismissed, or nobody to ask: asked again next session
    }
    if (choice === ONBOARD) await $.prompt.submit({ text: "/sessionkit:architecture onboard" });
    if (choice === NEVER) {
      await $.process.run([SESSIONKIT, "hook", "architect-decline"], { stdin: JSON.stringify({ root: check.root }), timeoutMs: TIMEOUT_MS });
      $.ui.toast("sessionkit: no architect for this project. /sessionkit:architecture onboard still works when you change your mind.");
    }
  } catch (error) {
    $.ui.log(`${PREFIX}: no offer (${reason(error)})`);
  }
}

/** @type {import('claude-code').Register} */
export const register = (on, options) => {
  if (options?.architect === "off") return;

  on("session.start", async ($, event, next) => {
    await registerReviewer($).catch((error) => $.ui.log(`${PREFIX}: review agent not registered (${reason(error)})`));
    return next(event);
  });

  on("agent.offer", { agent: REVIEWER }, () => ({ isOffered: false }));

  on("agent.spawn", { subagentType: ARCHITECT }, async ($, event, next) => {
    const result = await next(event);
    if (result.agentId) architects.add(result.agentId);
    return result;
  });

  for (const tool of ["Edit", "Write", "ExitPlanMode"]) {
    on("tool.call", { tool }, async ($, event, next) => {
      const own = architects.has(event.agentId);
      if (own && tool !== "ExitPlanMode" && !allowed(event.file_path ?? "")) {
        return { deny: "The architect writes only ARCHITECTURE.md and docs/adr/." };
      }
      const result = await next(event);
      if (own || "deny" in result || result.isError) return result;
      const change = changeOf(tool, event, result);
      if (change) $.clock.after(0, () => classify($, change, event.agentId, options));
      return result;
    });
  }

  on("turn.complete", async ($, event, next) => {
    const result = await next(event);
    const run = runs.get(event.agentId);
    if (run) {
      runs.delete(event.agentId);
      running = false;
      $.clock.after(0, async () => {
        if (run.kind === "review") await deliver($, run.items, event.answer);
        else $.ui.log(`${PREFIX}: ${String(event.answer ?? "").trim().split("\n")[0]}`);
        await after($, false);
      });
    } else if (!event.agentId && event.reason === "answer") {
      $.clock.after(0, async () => {
        await after($, true);
        if (!offered) {
          offered = true;
          await offer($);
        }
      });
    }
    return result;
  });
};
