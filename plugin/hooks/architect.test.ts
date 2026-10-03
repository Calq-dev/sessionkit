// The architect, against the engine: sessionkit (Jev's reading), the tools, the subagents and the
// person are stood in for beneath the plugin. Run with: claude plugin test plugin
//
// The test kit gives a plugin's own $.agent.spawn no agent id (core sets it), so a review that
// the plugin starts cannot be followed to its answer here, and a session does not show a plugin
// the tool calls of an agent it started itself. The answer's way into the context is
// tested through deliver and after with the test's own engine; the whole loop was run live.
import { expect, mock, test } from "claude-code/testing";
import { after, deliver, offer } from "./architect.js";

const QUIET = { wake: false, relevance: 0.02, category: "local" };
const LOUD = { wake: true, relevance: 0.97, category: "boundary", root: "/repo", brief: "Review. Repository: /repo. The coding agent made this edit to `src/checkout/complete.rs`." };

/** Stand-ins for the world beneath the plugin; `checks` answers each architect-check in turn. */
function world(on, checks) {
  const seen = { checked: [], spawns: [], appended: [], asked: [], logs: [] };
  const answers = [...checks];
  on("session.id", () => ({ value: "session-1" }));
  on("session.cwd", () => ({ value: "/repo" }));
  on("process.run", (_$, e) => {
    if (e.argv[2] !== "architect-check") return { value: { exitCode: 0, stdout: "{}", stderr: "" } };
    seen.checked.push(JSON.parse(e.init.stdin));
    return { value: { exitCode: 0, stdout: JSON.stringify(answers.shift() ?? QUIET), stderr: "" } };
  });
  on("tool.call", { tool: "Edit" }, (_$, e) => ({
    result: { filePath: e.file_path, oldString: e.old_string, newString: e.new_string, originalFile: "", userModified: false, replaceAll: false,
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`-${e.old_string}`, `+${e.new_string}`] }] },
  }));
  on("tool.call", { tool: "Write" }, (_$, e) => ({ result: { type: "create", filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: null } }));
  on("tool.call", { tool: "ExitPlanMode" }, () => ({ result: { plan: "1. Checkout writes invoice rows itself.", isAgent: false } }));
  // A plugin's spawn reaches this in the Agent tool's words, a test's own in the event's.
  on("agent.spawn", (_$, e) => {
    seen.spawns.push({ type: e.subagentType ?? e.subagent_type, prompt: e.prompt });
    return { model: "claude-sonnet-5-5", agentId: `architect-${seen.spawns.length}` };
  });
  on("session.append", (_$, e, next) => {
    seen.appended.push({ text: e.message.content[0].text, agentId: e.agentId });
    return next(e);
  });
  on("ui.log", (_$, e) => { seen.logs.push(e.text); return { value: undefined }; });
  return seen;
}

const EDIT = { tool: "Edit", file_path: "/repo/src/checkout/complete.rs", old_string: "let t = 1;", new_string: "use crate::billing::persistence::InvoiceRepository;" };
const REVIEWED = [{ brief: LOUD.brief, loop: "worker-1", file: EDIT.file_path, root: "/repo" }];

/** The test's engine with the display a plugin's own has: its log, and the person's `choice`. */
const engine = ($, seen, choice) => ({
  ...$,
  ui: {
    log: (text) => void seen.logs.push(text),
    ask: async (question, { options }) => {
      seen.asked.push({ question, options });
      if (choice === undefined) throw new Error("dismissed");
      return choice;
    },
  },
});

const ADVICE = "VERDICT: ADVICE\nThis writes invoices from Checkout; the memory gives invoice persistence to Billing.\nGo through BillingGateway.";
const DECISION = "VERDICT: DECISION\nCheckout takes over invoice persistence from Billing.\nIf intended, record it.\nQUESTION: Should Checkout own invoice persistence from now on?";

test("an ordinary edit is checked and wakes nothing", async ($, on) => {
  const clock = mock.clock(on);
  const seen = world(on, [QUIET]);
  const result = await $.tool.call({ ...EDIT, new_string: "let total = 1;" });
  expect(result.result.filePath).toBe(EDIT.file_path);
  await clock.settle();
  expect(seen.checked).toEqual([{ session_id: "session-1", cwd: "/repo", kind: "edit", file: EDIT.file_path, change: "-let t = 1;\n+let total = 1;", earlier: [] }]);
  expect(seen.spawns).toEqual([]);
});

test("an architectural edit wakes the architect with the brief, in the background", async ($, on) => {
  const clock = mock.clock(on);
  const seen = world(on, [LOUD]);
  await $.tool.call(EDIT);
  await clock.settle();
  expect(seen.spawns).toEqual([{ type: "sessionkit:architect-review", prompt: LOUD.brief }]);
});

test("a plan is checked as a plan", async ($, on) => {
  const clock = mock.clock(on);
  const seen = world(on, [QUIET]);
  await $.tool.call({ tool: "ExitPlanMode" });
  await clock.settle();
  expect(seen.checked[0]).toMatchObject({ kind: "plan", file: "", change: "1. Checkout writes invoice rows itself." });
});

test("a new file is checked with its content", async ($, on) => {
  const clock = mock.clock(on);
  const seen = world(on, [QUIET]);
  await $.tool.call({ tool: "Write", file_path: "/repo/src/checkout/invoice.rs", content: "pub struct Invoice;" });
  await clock.settle();
  expect(seen.checked[0]).toMatchObject({ kind: "create", file: "/repo/src/checkout/invoice.rs", change: "pub struct Invoice;" });
});

test("in shadow Jev's reading is logged by sessionkit and nothing wakes", { options: { architect: "shadow" } }, async ($, on) => {
  const clock = mock.clock(on);
  const seen = world(on, [LOUD]);
  await $.tool.call(EDIT);
  await clock.settle();
  expect(seen.checked.length).toBe(1);
  expect(seen.spawns).toEqual([]);
});

test("off checks nothing", { options: { architect: "off" } }, async ($, on) => {
  const clock = mock.clock(on);
  const seen = world(on, [LOUD]);
  await $.tool.call(EDIT);
  await clock.settle();
  expect(seen.checked).toEqual([]);
});

test("an architect writes only its memory, and its writes are not checked", async ($, on) => {
  const clock = mock.clock(on);
  const seen = world(on, []);
  const { agentId } = await $.agent.spawn({ subagentType: "sessionkit:architect", prompt: "Onboard. Repository: /repo." });
  const code = await $.tool.call({ ...EDIT, agentId });
  expect(code.deny).toContain("The architect writes only ARCHITECTURE.md and docs/adr/");
  const memory = await $.tool.call({ tool: "Write", file_path: "/repo/ARCHITECTURE.md", content: "# Architecture", agentId });
  expect(memory.deny).toBeUndefined();
  const adr = await $.tool.call({ tool: "Write", file_path: "/repo/docs/adr/0005-billing-owns-invoices.md", content: "# Billing", agentId });
  expect(adr.deny).toBeUndefined();
  await clock.settle();
  expect(seen.checked).toEqual([]);
});

test("advice goes to the loop that made the change, or to the main conversation once that loop has ended", async ($, on) => {
  const seen = world(on, []);
  await deliver(engine($, seen), REVIEWED, ADVICE);
  const text = `sessionkit architect (ADVICE, on ${EDIT.file_path}): This writes invoices from Checkout; the memory gives invoice persistence to Billing.\nGo through BillingGateway.`;
  // No loop worker-1 runs in the test, so the engine refuses the first row and the main conversation takes it.
  expect(seen.appended).toEqual([{ agentId: "worker-1", text }, { agentId: undefined, text }]);
  expect(seen.asked).toEqual([]);
});

test("no concern stays out of the context", async ($, on) => {
  const seen = world(on, []);
  await deliver(engine($, seen), REVIEWED, "VERDICT: NO_CONCERN\nBilling is called through its gateway.");
  expect(seen.appended).toEqual([]);
});

test("a decision is put to the person; taken as one, it is recorded when the main turn ends", async ($, on) => {
  const seen = world(on, []);
  await deliver(engine($, seen, "Take it as a decision"), REVIEWED, DECISION);
  expect(seen.asked).toEqual([{ question: "Architect: Should Checkout own invoice persistence from now on?", options: ["Follow the advice", "Take it as a decision", "Discuss first"] }]);
  expect(seen.appended[0].text).toContain("The person takes this as an intended architectural decision: go on.");
  expect(seen.appended[0].text).not.toContain("QUESTION:");
  await after(engine($, seen), true);
  expect(seen.spawns).toEqual([{
    type: "sessionkit:architect",
    prompt: `Record. Repository: /repo. Decisions:\n- ${EDIT.file_path}: Checkout takes over invoice persistence from Billing.`,
  }]);
});

test("a decision the person wants to discuss stops the coding agent after its step", async ($, on) => {
  const seen = world(on, []);
  await deliver(engine($, seen, "Discuss first"), REVIEWED, DECISION);
  expect(seen.appended[0].text).toContain("then stop and put the architect's concern and the options to the person");
});

test("a dismissed question leaves the advice as it is, and nothing is recorded", async ($, on) => {
  const seen = world(on, []);
  await deliver(engine($, seen), REVIEWED, DECISION);
  expect(seen.appended[0].text).toBe(`sessionkit architect (DECISION, on ${EDIT.file_path}): Checkout takes over invoice persistence from Billing.\nIf intended, record it.`);
  await after(engine($, seen), true);
  expect(seen.spawns).toEqual([]);
});

/** The engine for offer: sessionkit's answers per hook, and what the plugin did with them. */
function offering(answer, choice) {
  const seen = { asked: [], ran: [], submitted: [], toasts: [], logs: [] };
  const $ = {
    session: { cwd: async () => "/repo/src" },
    process: { run: async (argv, { stdin }) => {
      seen.ran.push({ hook: argv[2], input: JSON.parse(stdin) });
      return { exitCode: 0, stdout: JSON.stringify(argv[2] === "architect-offer" ? answer : { saved: "x" }), stderr: "" };
    } },
    prompt: { submit: async ({ text }) => void seen.submitted.push(text) },
  };
  return { seen, $: { ...engine($, seen, choice), ui: { ...engine($, seen, choice).ui, toast: (text) => void seen.toasts.push(text) } } };
}

const OFFER = { ask: true, root: "/repo", question: "repo has no architect yet. Onboard one?" };

test("a repository without an architect is offered one, and onboarding starts on yes", async () => {
  const { seen, $ } = offering(OFFER, "Onboard now");
  await offer($);
  expect(seen.ran[0]).toEqual({ hook: "architect-offer", input: { cwd: "/repo/src" } });
  expect(seen.asked).toEqual([{ question: OFFER.question, options: ["Onboard now", "Not now", "Never for this project"] }]);
  expect(seen.submitted).toEqual(["/sessionkit:architecture onboard"]);
});

test("never for this project is saved for that repository", async () => {
  const { seen, $ } = offering(OFFER, "Never for this project");
  await offer($);
  expect(seen.ran[1]).toEqual({ hook: "architect-decline", input: { root: "/repo" } });
  expect(seen.submitted).toEqual([]);
  expect(seen.toasts.length).toBe(1);
});

test("not now, a dismissed question or a repository that needs no offer changes nothing", async () => {
  for (const [answer, choice] of [[OFFER, "Not now"], [OFFER, undefined], [{ ask: false, reason: "declined" }, "Onboard now"]]) {
    const { seen, $ } = offering(answer, choice);
    await offer($);
    expect(seen.ran.map((r) => r.hook)).toEqual(["architect-offer"]);
    expect(seen.submitted).toEqual([]);
  }
});
