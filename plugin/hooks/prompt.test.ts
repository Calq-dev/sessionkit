// The cold-cache dialog against the engine: sessionkit, the session and the person are stood in
// for beneath the plugin. Run with: claude plugin test plugin
import { expect, test } from "claude-code/testing";

const COLD = {
  cold: true,
  cost: "$2.82",
  fresh: true,
  question: "The prompt cache of this session has expired. Where do you go on?",
  stop: "sessionkit: your message is back in the prompt box.",
};

/** Stand-ins for the world beneath the plugin; returns what each was asked. */
function world(on, check, answer) {
  const seen = { runs: [], asked: [], filled: [], entered: [] };
  on("session.id", () => ({ value: "session-1" }));
  on("process.run", (_$, e) => {
    seen.runs.push(e.argv.slice(2).join(" "));
    const out = e.argv[2] === "cold-check" ? check : { ok: true };
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: "" } };
  });
  on("tool.call", { tool: "AskUserQuestion" }, (_$, e) => {
    const question = e.questions[0];
    seen.asked.push(question.options.map((o) => o.label));
    if (answer === undefined) return { deny: "dismissed" };
    const label = question.options.map((o) => o.label).find((l) => l.startsWith(answer));
    return { result: { questions: e.questions, answers: { [question.question]: label } } };
  });
  on("prompt.fill", (_$, e) => {
    seen.filled.push(e.text);
    return { isFilled: true };
  });
  on("prompt.submit", (_$, e) => {
    seen.entered.push(e.text);
    return { text: e.text };
  });
  return seen;
}

const typed = (text) => ({ text, wait: false, origin: { kind: "composer" } });

test("a warm session goes through without a question", async ($, on) => {
  const seen = world(on, { cold: false });
  const result = await $.prompt.submit(typed("hello"));
  expect(result).toEqual({ text: "hello" });
  expect(seen.asked).toEqual([]);
});

test("continue here acks and lets the message through", async ($, on) => {
  const seen = world(on, COLD, "Continue here");
  const result = await $.prompt.submit(typed("hello"));
  expect(seen.asked).toEqual([["Fresh session", "Continue here ($2.82)"]]);
  expect(seen.runs).toEqual(["cold-check", "cold-choice continue"]);
  expect(result).toEqual({ text: "hello" });
});

test("a fresh session hands the message over and keeps it out of this one", async ($, on) => {
  const seen = world(on, COLD, "Fresh session");
  const result = await $.prompt.submit(typed("hello"));
  expect(seen.runs).toEqual(["cold-check", "cold-choice fresh"]);
  expect(seen.entered).toEqual([]);
  expect(result.drop).toContain("fresh one");
});

test("without a way to open a fresh session, stop puts the message back", async ($, on) => {
  const seen = world(on, { ...COLD, fresh: false }, "Stop");
  const result = await $.prompt.submit(typed("hello"));
  expect(seen.asked).toEqual([["Continue here ($2.82)", "Stop"]]);
  expect(seen.filled).toEqual(["hello"]);
  expect(result).toEqual({ drop: COLD.stop });
});

test("a dismissed dialog puts the message back", async ($, on) => {
  const seen = world(on, COLD, undefined);
  const result = await $.prompt.submit(typed("hello"));
  expect(seen.filled).toEqual(["hello"]);
  expect(seen.entered).toEqual([]);
  expect(result).toEqual({ drop: COLD.stop });
});

test("a message from a peer is not asked about", async ($, on) => {
  const seen = world(on, COLD, "Continue here");
  await $.prompt.submit({ text: "hello", wait: false, origin: { kind: "peer", from: "other" } });
  expect(seen.runs).toEqual([]);
});
