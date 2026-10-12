# Question-led exploration: offline contract pilot

Status: experimental, local only. No production tool, onboarding reroute, paid
model call, LMNL-source transfer or persistent project knowledge change.

## Implemented

- `explore.py`: incremental JSON evidence ledger and lexical retrieval over an
  explicitly selected local root. Questions require explicit anchors; the program
  does not understand their semantics or generate a research agenda.
- Focused follow-up by evidence-node ID, question/evidence links, optional typed
  relationship proposals with resolved endpoints, and explicit counterevidence.
- Evidence nodes bind file content hashes and exact normalized line ranges/quotes.
  Follow-ups fail if previously inspected contents changed. Snapshot coverage is
  limited to inspected files; new files and uninspected content are not covered.
- All semantic proposals remain unverified. Valid quotes do not establish truth.
- Cumulative limits: 20 valid requests, 12,000 unique excerpt bytes, 2 MB retrieval
  scan bytes and 200 file inspections. Revalidation reads are additional local I/O,
  not counted as retrieval scan bytes. Excerpts are not cropped to fake completeness.
  A budget gap is explicit and questions remain open. There is no network/JeV call.
- Invalid requests leave the caller's state unchanged. Symlinks, traversal, common
  dependency/hidden state directories and `.env*` are excluded. This is not a
  comprehensive sensitive-content filter or an OS sandbox. Use synthetic fixtures.
- `QUESTIONS.md` plus `run.py --strategy questions`: a prescribed question-led
  treatment using existing native Jev tools, with the same final report contract.
  This method's in-context evidence map is NOT connected to the offline ledger;
  no `explore_repo` tool is registered. Native requests remain separately paid and
  the existing Claude budget is not a Jev dollar cap.

## Executed smoke

Source: existing synthetic `cases/revision` only. A manually supplied two-question
agenda asks about cache identity/revision and submission's revision lifecycle.
A third question focuses exclusively on a previously located repository.py node.
Finally a manually supplied proposal records that submission assigns revision 1
while retitle increments it, leaving cache-collision implications as a question.

Before the final record, all returned evidence was source/hash validated. The run
used 3 ledger requests, 2,169 unique excerpt bytes, 2,930 retrieval scan bytes,
9 file inspections, 3 questions and 16 evidence nodes. Focused follow-up inspected
only `app/repository.py`. Proposal standing: `unverified_proposal`. Paid calls: 0.
Raw ledger stayed in a local system temporary directory and is not published.

These counts test plumbing, not research quality. The agenda, anchors, focus and
proposal were supplied by the implementing assistant, not autonomously selected
by a survey model. The identity-reuse counterexample is already known from the
existing executable oracle: this pilot did not independently discover it.

## Validation and boundaries

The original 21 offline evaluator tests plus 11 new ledger tests and one new
runner-argument test pass (33 total). New tests
cover focused incremental exploration, excerpt reuse, changed contents, fabricated
quotes, budgets, request bounds, symlink/sensitive-name exclusions, cross-root
rejection, transactional failures, unresolved evidence and non-promotion of claims.
Question-led selection without native tools is rejected before a Claude request.
No inference about semantic accuracy, adoption, token savings or combined costs.

## Next experiment, not yet run

Compare read-led and question-led methods with the SAME native tool inventory,
model, fixture, budget and report schema. Counterbalance execution order, preserve
method/source hashes, inspect actual question/tool sequences and review against
state oracles. Starting diagnostic: `revision`, not LMNL or client repositories.
The question-led treatment prescribes tool usage; it is not an adoption test.
The treatment changes both research order and tool-selection instructions.

Before paid dispatch, disclose estimated Claude/Jev expenditure and acknowledge
unknown grep usage. A request-count bound is not a provider-spend guarantee.
A following graph-integrated experiment would need an explicit ledger tool and
server-owned state; neither is implemented in this pilot. Keep onboarding unchanged.
