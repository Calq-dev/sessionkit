// sessionkit's choice before a message to a cold session: when the prompt cache has expired and
// writing the context again is expensive, ask in Claude Code's own dialog whether to go on here
// or in a fresh session with only what matters. The dialog is the engine's, so asking costs no
// model call. `sessionkit hook cold-check` decides whether to ask and words the question;
// `sessionkit hook cold-choice` acts on the answer. When anything fails, the message goes through,
// and the settings hook `sessionkit hook prompt` still stops it once.
//
// sessionkit setup writes this file with the path of sessionkit on this machine.

const SESSIONKIT = "__SESSIONKIT__";
const TIMEOUT_MS = 10_000;

const FRESH = "Fresh session";
const STOP = "Stop";

async function sessionkit($, args, input) {
  const run = await $.process.run([SESSIONKIT, "hook", ...args], { stdin: JSON.stringify(input), timeoutMs: TIMEOUT_MS });
  return JSON.parse(run.stdout);
}

/** @type {import('claude-code').Register} */
export const register = (on) => {
  on("prompt.submit", async ($, event, next) => {
    // Only what the person typed: a peer's message or a plugin's prompt is not theirs to decide.
    if (event.origin.kind !== "composer" || event.text.trim() === "") return next(event);
    const input = { session_id: await $.session.id(), prompt: event.text };
    let check;
    try {
      check = await sessionkit($, ["cold-check"], input);
    } catch {
      return next(event);
    }
    if (!check.cold) return next(event);

    const here = `Continue here (${check.cost})`;
    let choice;
    try {
      choice = await $.ui.ask(check.question, { options: check.fresh ? [FRESH, here] : [here, STOP], header: "Cold cache" });
    } catch {
      choice = STOP; // dismissed
    }
    if (choice === here) {
      // Without the ack the settings hook stops the message once; sending it again goes through.
      await sessionkit($, ["cold-choice", "continue"], input).catch(() => undefined);
      return next(event);
    }
    try {
      if (choice === FRESH) {
        const answer = await sessionkit($, ["cold-choice", "fresh"], input);
        if (answer.ok) return { drop: "sessionkit: closing this session; your message continues in a fresh one." };
      }
    } catch {
      // Fall through: keep the message, and let the person decide again.
    }
    await $.prompt.fill({ text: event.text });
    return { drop: check.stop };
  });
};
