// sessionkit's compaction for Claude Code: hands the conversation to `sessionkit compact --hook`,
// which asks Jev per tool call whether the call and its output are still needed, and puts the
// plan it prints in place of the summary. All text stays verbatim. When sessionkit cannot do
// it, or it would free too little, Claude Code writes its own summary as before.
//
// sessionkit setup writes this file with the path of sessionkit on this machine.

const SESSIONKIT = "__SESSIONKIT__";
const TIMEOUT_MS = 180_000;

/** The messages without the engine's handles and stored records: what sessionkit reads. */
function plain(messages) {
  return messages.map((m) => ({
    role: m.role,
    text: m.text,
    toolUses: m.toolUses.map((u) => ({ tool_use_id: u.tool_use_id, tool: u.tool, input: u.input, text: u.text, isError: u.isError })),
    toolResults: (m.toolResults ?? []).map((r) => ({ tool_use_id: r.tool_use_id, text: r.text, isError: r.isError })),
  }));
}

/**
 * The plan applied: a kept message is the engine's own, handle and all; a rebuilt one takes its
 * tool blocks from the original, with the output cut where the plan says so.
 */
function apply(messages, plan) {
  return plan.map((step) => {
    if (step.keep !== undefined) return messages[step.keep];
    const m = messages[step.from];
    const toolUses = step.toolUses.map((p) => {
      const u = m.toolUses[p.keep];
      if (p.text === undefined) return u;
      const cut = { tool_use_id: u.tool_use_id, tool: u.tool, input: u.input, text: p.text };
      if (u.isError) cut.isError = true;
      return cut;
    });
    const results = step.toolResults.map((p) => {
      const r = m.toolResults[p.keep];
      return p.text === undefined ? r : { tool_use_id: r.tool_use_id, text: p.text, isError: r.isError };
    });
    const rebuilt = { role: m.role, text: m.text, toolUses };
    if (results.length > 0) rebuilt.toolResults = results;
    return rebuilt;
  });
}

/** @type {import('claude-code').Register} */
export const register = (on) => {
  on("session.compact", async ($, event, next) => {
    // A precompute runs ahead of time; its outcome is for the log, not for a toast.
    const say = (text) => {
      $.ui.log(`sessionkit: ${text}`);
      if (event.trigger !== "precompute") $.ui.toast(`sessionkit: ${text}`, { timeoutMs: 15_000 });
    };
    try {
      const run = await $.process.run([SESSIONKIT, "compact", "--hook"], {
        stdin: JSON.stringify({ messages: plain(event.messages) }),
        timeoutMs: TIMEOUT_MS,
      });
      let answer;
      try {
        answer = JSON.parse(run.stdout);
      } catch {
        answer = { fallback: (run.stderr || run.stdout || `exit ${run.exitCode}`).trim().slice(0, 300) };
      }
      if (!answer.plan) {
        say(`summary as usual (${answer.fallback})`);
        return next(event);
      }
      say(answer.summary);
      return { messages: apply(event.messages, answer.plan) };
    } catch (error) {
      say(`summary as usual (${error instanceof Error ? error.message : String(error)})`);
      return next(event);
    }
  });
};
