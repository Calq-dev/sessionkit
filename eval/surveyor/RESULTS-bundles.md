# Fixed large question bundles: real-repository pilot

Date: 2026-10-06. Status: completed exploratory pilot, not production promotion.
This summary intentionally omits the private repository identity, filenames,
source quotes, local artifact paths, raw responses and conversations. The detailed
source-bearing report and evidence remain private outside this repository.

Research rationale: [Jev codebase-mapping notes](../../docs/jev-codebase-mapping.md).
Implementation and usage boundaries: [evaluation README](README.md).

## Question and method

Can a fixed source-local investigation bundle be answered in one request per
file, and which kinds of findings/evidence need additional verification?

With explicit approval of sources/provider and estimated expenditure, send three
selected PHP domain-service files from one real project to TypeSafe. Each request
contains the same 28 propositions: 16 base questions and 12 deliberately selected
version-workflow questions. Every proposition has a separate evidence Choice over
numbered source windows plus `none`: 56 typed questions per request.

The complete file is represented by 12-line verbatim windows at a 10-line stride.
Overlapping lines therefore recur within the state; the entire state is not resent
once per question. Assessment options are supported, contradicted, uncertain and
not_demonstrated. A question's answer cannot consume another answer in the same
request. Selected evidence is a lead, not proof of semantic support.

This is a manually scoped, closed-set detection experiment, not a full survey,
autonomous agenda/module selection, adaptive exploration or graph extraction.
The experiment bypasses the existing CLI/native-tool ten-question restriction;
that production restriction remains unchanged.

## Execution measurements

| Measure | Result |
|---|---:|
| Actual model | `jev-1.13.0` |
| Files / paid requests | 3 / 3 |
| Typed questions answered | 168 |
| Substantive assessments | 84 |
| Input tokens reported by API | 84,093 |
| Output tokens reported by API | 45,330 |
| Sum of request durations | 2.19 s |
| Conservative pre-dispatch estimate | $0.010591434 |
| Usage-based cost estimate | $0.003531906 |

The individual request durations were 0.87, 0.53 and 0.79 seconds. Duration excludes
preparation, local source/test reading and review. It is not end-to-end survey
latency or a comparison with sequential/concurrent unbundled requests.

Costs use API input usage at the locally assumed $0.042/M input-only tariff;
output is assumed free. This is not a provider invoice. The approved estimate
boundary was $0.02, not a provider-enforced spending guarantee. No retries occurred.
No Claude calls were made, so this run supplies no combined-agent cost comparison.
All three source content hashes remained unchanged.

## Preselected review versus post-run counterchecks

Before paid dispatch, the manifest froze 24 assistant-selected checks and expected
assessment categories. Twenty-three categories agreed. This is NOT overall
accuracy: selection was small, mostly known positive cases, reviewed by the
implementing assistant, not independent gold, and not all 84 assessments.

Ten selected positive evidence windows required additional context, caller/helper
links or framework semantics. Exact quotes and category agreement are not enough
to claim a self-contained architectural explanation.

The frozen counterexample failed: a proposition claimed that automatic derivation
never modifies ANY field of a human-decided record. The model selected a local
branch that protects decision-related fields and answered supported. Another
operation in the same file still updates a relationship field without excluding
those records. The correct distinction is protection of specific decisions, not
immutability of every field. This is a survey overclaim, not a demonstrated defect
in the project. Winning probability was 0.71; derived provider confidence 0.61.
The selected evidence was itself ambiguous (winning probability 0.38, provider
confidence 0.36). Neither statistic is independent verification.

Four additional POST-RUN checks exposed conflations:

- Applying results only to drafts is not explicit rejection of every non-draft write.
- A selected passage did not substantiate a caller-owned transaction requirement.
- A revision round was mistaken for nested-batch derivation.
- Publication gating was mistaken for the implementation of revision application.

These findings are not silently added to the frozen-check denominator. Some were
low-certainty leads, but all show why unsupported labels cannot become facts.
No-mentioned-operation was also sometimes labelled contradicted without a concrete
counterexample. Missing evidence should instead remain scoped unknown.

Across all 84 propositions, the model returned 39 supported, 39 not_demonstrated,
4 contradicted and 2 uncertain. These are output counts, not validated truth labels.
Many questions were irrelevant to individual files; more bundled questions alone
does not imply a better research agenda.

## Artifacts, safeguards and verification

Private artifacts include the prepared payloads, source/protocol/request hashes,
frozen review selection, start markers, raw provider responses/usage, parsed and
enriched results, and manual review notes. A derived map has 110 nodes and 51
question/evidence associations; these are NOT verified dependency/runtime edges.

Only the three approved sources and questions were sent. Tests and one supporting
model helper were inspected locally, not transmitted. Existing project tests were
READ, not run. No application commands, services, database queries or mutations
were performed. No source-bearing artifacts or raw transcripts are included here.

Forty SessionKit offline evaluator tests pass after the pilot, including seven
bundle tests using synthetic sources and mocked network only. Tests cover fixed
question/window construction, malformed answers, offline preparation, source
changes, three-call execution, missing usage and uncertain failures without retry.
A post-run canonical-path guard regression was caught on macOS and fixed; no new
paid request was needed to verify it.

## Interpretation and next steps

**Established:** this 56-question bundle can be answered in one request per file;
the fixed protocol supplies useful local leads at the measured workload and tariff.

**Not established:** batching equivalence, autonomous tool adoption, complete
architecture coverage, improved accuracy/recall, reduced reviewer burden, total
cost savings, security validation or superiority over read-led surveying.

Next iteration:

1. Select relevant mechanism modules rather than sending every domain question to
   every file. Keep a fixed versioned protocol, not proliferating project skills.
2. Scope propositions to concrete operations, fields and conditions; do not blur
   local, delegated and caller-owned behavior.
3. Pair consequential/universal claims with explicit counterexample questions and
   link multiple source locations when conditions, gates and effects are separate.
4. Keep the present real-project slice as a DEVELOPMENT regression, not a held-out
   corpus. Test transfer on unseen files with independently reviewed labels.
5. Separately integrate and evaluate the agent's question/evidence/follow-up loop
   against a read-led control with the same inventory and quality/budget criteria.

No production surveyor, integrated `explore_repo`, onboarding reroute, permission
change or additional paid run follows automatically from this pilot.
