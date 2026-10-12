// sessionkit's architect: a repository onboarded with /sessionkit:architecture onboard has an
// architect, the agent type sessionkit:architect, with its memory in ARCHITECTURE.md. It speaks
// at four moments of a turn, each through `sessionkit hook architect-check`, where Jev reads what
// a text does to the architecture in the memory:
//
// - Before: the person's message is read as a request. When doing it would touch the
//   architecture, the lines of the memory and the decision records that apply go with the
//   message as context, so the agent plans with the rule in view.
// - During: each plan the agent presents and each Edit or Write it makes is read after it is
//   done, without waiting. For an architectural one, the loop that made it gets a note: the file,
//   Jev's reading, the rule it touches and the records it may go against. The agent judges a
//   small case itself and starts sessionkit:architect only for a large one, where a reading
//   without its own reasoning adds something.
// - At the end of the turn: everything the turn changed is read once more, with what the agent
//   said, for a decision it took without recording it and for notes it left unanswered. What is
//   open comes back as the next turn, so nothing slips by unseen; nothing is blocked.
// - A decision the person takes, the architect records in the memory.
//
// The plugin starts no agent: in auto mode the server-side classifier judges only calls a model
// request asked for, and refuses a spawn from a hook.
//
// A repository with a GLOSSARY.md (the format of the domain-modeling skill: a term, its
// definition, the words to avoid for it) has its language watched the same way: a change that
// names a concept by a word the glossary rules out gets the term quoted to its line, and a turn
// that names a concept the glossary lacks is asked to add it or name it by a term it has.
//
// An architect the model starts is held to ARCHITECTURE.md, docs/adr/ and the glossaries by the
// tool.call hook below, and its own changes are not checked.
//
// In a git repository without an onboarded memory, the first answer of a session is followed by
// one question: onboard an architect now, not now (asked again next session), or never for this
// repository, which `sessionkit hook architect-decline` keeps in ~/.config/sessionkit/architect.json.
//
// The option architect sets advise (the default), shadow (Jev's reading is logged in
// ~/.cache/sessionkit/architect-checks.jsonl, no note) or off. Without the memory, or without a
// TypeSafe key at hand, nothing is asked.
//
// sessionkit setup writes this file with the path of sessionkit on this machine.

const SESSIONKIT = "__SESSIONKIT__";
const TIMEOUT_MS = 30_000;
const BRIEF_TIMEOUT_MS = 20_000; // holds the person's message; Jev answers in a few seconds
const TURN_TIMEOUT_MS = 60_000;
const ARCHITECT = "sessionkit:architect";
const PREFIX = "sessionkit architect";

const ONBOARD = "Onboard now";
const NOT_NOW = "Not now";
const NEVER = "Never for this project";

const architects = new Set(); // architects the model started
const noted = new Set(); // file and reading already noted this session, so a note is not repeated
const turns = new Map(); // per loop (agentId, "" for the main conversation): what its current turn changed
let offered = false;

/** The current turn of a loop: the files it changed, their patches, the notes it got, whether it started the architect. */
function turnOf(loop) {
  const key = loop ?? "";
  if (!turns.has(key)) turns.set(key, { files: new Set(), patches: [], notes: [], spawned: false });
  return turns.get(key);
}

/** The glossary terms a check read the change as misnaming, as a clause of a note or a brief. */
const misnamedClause = (check) => (check.misnamed?.length ? `; it names ${check.misnamed.join(", ")} by a word the glossary rules out` : "");

/** The rules a check found, one line each, for a note or a brief. */
const ruleLines = (check) => (check.rules ?? []).map((rule) => `\n- ${rule.file}:${rule.line}: ${rule.text}`).join("");

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
const allowed = (path) => /(^|\/)(ARCHITECTURE|GLOSSARY|GLOSSARY-MAP)\.md$/.test(path) || /(^|\/)docs\/adr\/[^/]+$/.test(path);

async function check($, input, timeoutMs = TIMEOUT_MS) {
  const stdin = JSON.stringify({ session_id: await $.session.id(), cwd: await $.session.cwd(), ...input });
  const run = await $.process.run([SESSIONKIT, "hook", "architect-check"], { stdin, timeoutMs });
  return JSON.parse(run.stdout);
}

async function classify($, change, loop, options) {
  try {
    const found = await check($, change);
    if (!found.wake || options?.architect === "shadow") return;
    await notify($, loop, { ...found, files: turnOf(loop).files.size });
  } catch (error) {
    $.ui.log(`${PREFIX}: change not checked (${reason(error)})`);
  }
}

/**
 * The person's message, read as a request before the agent acts on it: when doing it would touch
 * the architecture, the lines that apply go with the message as context. Nothing is asked of the
 * person and nothing is held back; a check that fails lets the message through as it is.
 */
export async function brief($, event, next, options) {
  let found;
  try {
    found = await check($, { kind: "prompt", file: "", change: event.text }, BRIEF_TIMEOUT_MS);
  } catch (error) {
    $.ui.log(`${PREFIX}: request not read (${reason(error)})`);
    return next(event);
  }
  if (!found.wake || options?.architect === "shadow") return next(event);
  const against = found.against?.length ? ` and may touch ${found.against.join(", ")}` : "";
  const text = `${PREFIX} (Jev): doing this touches the architecture in ARCHITECTURE.md: read as ${found.category} ` +
    `(${Number(found.relevance).toFixed(2)})${against}${misnamedClause(found)}. Keep to these rules, or put a change of them to the person ` +
    `before you make it:${ruleLines(found) || "\n- (see ARCHITECTURE.md and the records named above)"}` +
    Object.entries(found.against_text ?? {}).map(([file, text]) => `\n\n${file}:\n${text}`).join("");
  return next({ ...event, context: [...(event.context ?? []), text] });
}

/**
 * The turn as a whole, once the agent has answered: its diff and what it said, read for a decision
 * it took without recording it and for notes it did not deal with. What is open comes back as the
 * next turn; the agent then deals with it or puts it to the person. One check per turn that changed
 * something or got a note; a turn that did neither costs nothing.
 */
export async function close($, turn, answer, options) {
  if (turn.patches.length === 0 && turn.notes.length === 0) return;
  let found;
  try {
    found = await check($, { kind: "turn", file: "", change: turn.patches.join("\n"), answer, notes: turn.notes }, TURN_TIMEOUT_MS);
  } catch (error) {
    return $.ui.log(`${PREFIX}: turn not read (${reason(error)})`);
  }
  if (options?.architect === "shadow") return;
  const open = turn.notes.filter((_, i) => !turn.spawned && (found.addressed?.[i] ?? 1) < 0.5);
  const points = [];
  if (found.decided) {
    points.push(`This turn takes an architectural decision (${Number(found.decision).toFixed(2)}): read as ${found.category}` +
      `${found.against?.length ? `, against ${found.against.join(", ")}` : ""}.${ruleLines(found)}\nIf it is intended, put it to the person ` +
      `and have ${ARCHITECT} record it with a prompt that starts with \`Record.\`; if not, undo it or keep the boundary.`);
  }
  if (found.named) {
    points.push(`This turn names a domain concept the glossary does not define, or gives one a second name ` +
      `(${Number(found.new_term).toFixed(2)}). Name it by a term the glossary has, or put the new term to the person; ` +
      `a term they confirm, ${ARCHITECT} adds to GLOSSARY.md with a prompt that starts with \`Record.\`.`);
  }
  for (const note of open) points.push(`A note of this turn was not dealt with:\n${note.split("\n\n")[0]}`);
  if (points.length === 0) return;
  const text = `${PREFIX} (Jev): before this work is left, deal with the following; then go on.\n\n${points.join("\n\n")}`;
  await $.prompt.submit({ text }).catch((error) => $.ui.log(`${PREFIX}: follow-up not sent (${reason(error)})`));
}

/**
 * Jev's reading, as a note to the loop that made the change: what to check, and how, with the text
 * of each decision record it may go against, so the agent need not read them first. Once per
 * file and reading in a session. A subagent that has ended takes no rows; the main conversation does.
 */
export async function notify($, loop, check) {
  const against = check.against?.length ? `; it may go against ${check.against.join(", ")}` : "";
  const key = `${check.file}|${check.category}|${check.against ?? []}|${check.misnamed ?? []}`;
  if (noted.has(key)) return;
  noted.add(key);
  const size = check.files > 1 ? ` This turn has changed ${check.files} files so far.` : "";
  const text = `${PREFIX} (Jev): ${check.file ? `the change to ${check.file}` : "the plan"} may affect the architecture in ` +
    `ARCHITECTURE.md: read as ${check.category} (${Number(check.relevance).toFixed(2)})${against}${misnamedClause(check)}.${ruleLines(check)}\n` +
    `Check it before you go on, and judge it yourself first: you have the same model as the architect.${size} ` +
    `Start the agent ${ARCHITECT} in the background only for a large change (several modules, a new boundary, ownership ` +
    "or a contract) or when a reading without your own reasoning adds something: it sees the change and the memory, not " +
    `why you made it. Its prompt starts with \`Review. Repository: ${check.root}.\` and gives the file and the change. ` +
    `If the change breaks a rule or makes an architectural decision, put it to the person; a decision they take, ${ARCHITECT} ` +
    "records with a prompt that starts with `Record.`" +
    Object.entries(check.against_text ?? {}).map(([file, text]) => `\n\n${file}:\n${text}`).join("");
  turnOf(loop).notes.push(text);
  const message = { type: "user", content: [{ type: "text", text }] };
  await $.session.append({ message, ...(loop ? { agentId: loop } : {}) })
    .catch(() => (loop ? $.session.append({ message }) : undefined))
    .catch((error) => $.ui.log(`${PREFIX}: Jev's reading not delivered (${reason(error)})`));
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
    // Slash commands must use the command API, not a model prompt submission.
    if (choice === ONBOARD) await $.command.run({ command: "sessionkit:architecture", args: "onboard" });
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

  on("agent.spawn", { subagentType: ARCHITECT }, async ($, event, next) => {
    const result = await next(event);
    if (result.agentId) architects.add(result.agentId);
    turnOf(event.agentId).spawned = true;
    return result;
  });

  // Only what the person typed: a peer's message or a plugin's prompt is not a request to brief.
  on("prompt.submit", { origin: { kind: "composer" }, text: /\S/ }, ($, event, next) => brief($, event, next, options));

  // A subagent's turn starts clean; the main conversation's is taken at turn.complete.
  on("turn.start", { agentId: /./ }, ($, event, next) => {
    turns.delete(event.agentId);
    return next(event);
  });

  for (const tool of ["Edit", "Write", "ExitPlanMode"]) {
    on("tool.call", { tool }, async ($, event, next) => {
      const own = architects.has(event.agentId);
      if (own && tool !== "ExitPlanMode" && !allowed(event.file_path ?? "")) {
        return { deny: "The architect writes only ARCHITECTURE.md, GLOSSARY.md and docs/adr/." };
      }
      const result = await next(event);
      if (own || "deny" in result || result.isError) return result;
      const change = changeOf(tool, event, result);
      if (change) {
        const turn = turnOf(event.agentId);
        if (change.kind !== "plan") {
          turn.files.add(change.file);
          turn.patches.push(`${change.kind} ${change.file}\n${change.change}`);
        }
        $.clock.after(0, () => classify($, change, event.agentId, options));
      }
      return result;
    });
  }

  on("turn.complete", async ($, event, next) => {
    const result = await next(event);
    if (event.agentId || event.reason !== "answer") return result;
    const turn = turns.get("");
    turns.delete("");
    if (turn) $.clock.after(0, () => close($, turn, event.answer, options));
    if (!offered) {
      offered = true;
      $.clock.after(0, () => offer($));
    }
    return result;
  });
};
