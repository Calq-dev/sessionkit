# ADR 0007: The architect speaks at four moments of a turn

## Context

ADR 0005 has the architect's reading reach the coding agent as a note after an
edit or plan, with no veto. Two gaps showed in use. A note delivered after the
turn's last model request is read only on the next turn, if at all, so a
reading could slip by unseen. And the note came after the code was written,
while most violations come from not knowing the rule: the cheapest moment to
say it is before the first edit. A hard stop at the end of a turn was
considered; the function-hook engine's `turn.complete` cannot block, and a veto
would break the advice-not-enforcement line of ADR 0005.

## Decision

The architect speaks at four moments, each through the same Jev classifier in
`src/architect.rs`:

1. **Before the turn** (`prompt.submit`): the person's message is read as a
   request. When doing it would touch the architecture, the lines of the memory
   and the decision records that apply go with the message as context.
2. **During the turn** (`tool.call` on Edit, Write, ExitPlanMode): as in ADR
   0005, with the rule quoted to the line and the coding agent told to judge a
   small case itself and start the architect only for a large one.
3. **At the end of the turn** (`turn.complete` of the main conversation): the
   turn's diff and the agent's answer are read once for an architectural
   decision taken without being recorded, and each note of the turn is scored
   for whether the answer dealt with it. What is open comes back as the next
   turn through `prompt.submit`. Nothing is blocked.
4. **Recording**: a decision the person takes, the architect records, as before.

The classifier gains a question per change for "makes an architectural decision
of its own", a question per note for "dealt with", and a find over each
record and the memory for the line that states the rule. Superseded decision
records are not held against changes.

## Consequences

- A reading can no longer slip by: an unanswered note or an unrecorded decision
  returns as the next turn, where the agent deals with it or puts it to the
  person.
- The person's message is held for one Jev call (a few seconds) before it goes
  out; a check that fails lets the message through unchanged.
- One more Jev request per turn that changed something, and one find per rule
  quoted. Shadow mode logs all of it and sends nothing.
- A subagent's turn gets notes but no end-of-turn reading; the main
  conversation's reading covers what the subagent's work left in the tree only
  through the main turn's own edits. Revisit if subagents prove to be where
  decisions slip by.
- Review with a fresh context stays the coding agent's choice and is now
  framed as being for size, not for every note.
