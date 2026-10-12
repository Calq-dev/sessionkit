// Waiting in Bash, against the engine; sessionkit's wording and the Bash tool are stood in for beneath.
import { expect, test } from "claude-code/testing";
import { polls } from "./wait.js";

function world(on) {
  const seen = { runs: [], commands: [] };
  on("session.id", () => ({ value: "session-1" }));
  on("process.run", (_$, e) => {
    const input = JSON.parse(e.init.stdin);
    seen.runs.push(input);
    return { value: { exitCode: 0, stdout: JSON.stringify({ text: `worded ${input.kind} ${input.context ?? "?"}` }), stderr: "" } };
  });
  on("tool.call", { tool: "Bash" }, (_$, e) => {
    seen.commands.push(e.command);
    return { result: { type: "text", stdout: "ok", stderr: "", interrupted: false } };
  });
  on("turn.step", async function* (_$, e) {
    yield { kind: "stop", stopReason: "end_turn", usage: e.usage };
    return { turnId: e.turnId, index: e.index, answer: "", toolUses: [], stopReason: "end_turn", usage: e.usage };
  });
  return seen;
}

/** One model request of a loop whose context is `context` tokens. */
async function stepped($, agentId, model, context) {
  const usage = { input_tokens: 10, cache_read_input_tokens: context - 10, cache_creation_input_tokens: 0, output_tokens: 50 };
  const stream = $.turn.step({ model, messageCount: 3, turnId: "turn-1", index: 0, usage, ...(agentId ? { agentId } : {}) });
  for await (const _chunk of stream);
}

test("a poll loop in the foreground is refused with the loop's context", async ($, on) => {
  const seen = world(on);
  await stepped($, undefined, "claude-fable-5-1", 230_000);
  const result = await $.tool.call({ tool: "Bash", command: "until grep -q '^exit' /tmp/out.log; do sleep 5; done; tail -3 /tmp/out.log" });
  expect(result.deny).toBe("worded poll 230000");
  expect(seen.commands).toEqual([]);
  expect(seen.runs[0].model).toBe("claude-fable-5-1");
});

test("a subagent's poll is priced with its own context", async ($, on) => {
  const seen = world(on);
  await stepped($, undefined, "claude-fable-5-1", 400_000);
  await stepped($, "agent-1", "claude-sonnet-5-5", 50_000);
  const result = await $.tool.call({ tool: "Bash", command: "for i in $(seq 1 115); do [ -s done.txt ] && break; sleep 5; done", agentId: "agent-1" });
  expect(result.deny).toBe("worded poll 50000");
  expect(seen.runs[0].model).toBe("claude-sonnet-5-5");
});

test("the same loop in the background, and ordinary commands, go ahead", async ($, on) => {
  const seen = world(on);
  const background = await $.tool.call({ tool: "Bash", command: "until grep -q '^exit' out.log; do sleep 5; done", run_in_background: true });
  expect(background.deny).toBeUndefined();
  const plain = await $.tool.call({ tool: "Bash", command: "cargo test --locked 2>&1 | tail -20" });
  expect(plain.deny).toBeUndefined();
  expect(plain.context ?? []).toEqual([]);
  expect(seen.commands.length).toBe(2);
});

test("when sessionkit cannot word the line the plain line refuses", async ($, on) => {
  on("session.id", () => ({ value: "session-1" }));
  on("process.run", () => { throw new Error("no sessionkit"); });
  on("tool.call", { tool: "Bash" }, () => ({ result: { type: "text", stdout: "", stderr: "", interrupted: false } }));
  const result = await $.tool.call({ tool: "Bash", command: "while true; do sleep 10; done" });
  expect(result.deny).toContain("sessionkit: this command waits in Bash");
  expect(result.deny).toContain("run_in_background");
});

test("what waits and what does not", () => {
  expect(polls("until grep -q '^exit' x; do sleep 5; done")).toBe(true);
  expect(polls("for i in $(seq 1 115); do [ -s f ] && break; sleep 5; done")).toBe(true);
  expect(polls("while ! curl -s localhost:3000 >/dev/null; do\n  sleep 2\ndone")).toBe(true);
  expect(polls("sleep 300")).toBe(true);
  expect(polls("sleep 5m && echo done")).toBe(true);
  expect(polls("sleep 2 && curl localhost:3000")).toBe(false);
  expect(polls("for f in *.rs; do wc -l $f; done")).toBe(false);
  expect(polls("php artisan test --parallel")).toBe(false);
  expect(polls("grep -rn 'until' src/ | head")).toBe(false);
  expect(polls(undefined)).toBe(false);
});
