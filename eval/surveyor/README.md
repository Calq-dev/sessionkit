# As-built survey evaluation prototype

This tests a candidate reconstruction procedure before changing onboarding.
The production architecture skill/architect are unchanged. Method research and
promotion gates: [docs/survey-method.md](../../docs/survey-method.md).

## Corpus and contract

The original development fixture is an artificial, ten-file Python repository
with eight labeled checks in rubric.json:
multiple launch paths, a request path, a worker/external interface, direct-write
bypasses, configuration precedence, stale docs, a declared unused dependency and
an unconnected prototype. The README explicitly warns it is historical: this is
an easy diagnostic fixture, not a held-out benchmark or eight independent repos.

Two additional, less signposted transfer cases live in cases/snapshot and
cases/revision (five frozen rubric items each in cases/rubric.json). They contrast
copied jobs with identifier jobs, revision caching and dynamic activation. They
are targeted author-built fixtures, not an independent held-out corpus. Offline
oracles check ordinary transitions and a later-discovered identity-reuse failure.

The legacy condition uses stages 1-4 of the current ONBOARD.md. The candidate uses
SURVEY.md, with TRACE.md and REPORT.md read at their relevant stages. Both get the
same read-only scope, JSON report schema, source tools, model, effort and budget.
This adapts the old workflow: no actual calibration, writes or baseline acceptance
are tested. Shared evidence instructions already strengthen the legacy prompt.

## Offline tests (no key/network)

```sh
python3 -m unittest discover -s eval/surveyor -p 'test_*.py' -v
```

Forty tests cover schema/standing, fabricated quotes, line ranges,
traversal/symlink escapes, missing evidence, duplicate IDs/stream rows,
counterbalanced scheduling, fixture selection, executable state oracles,
minimal native-plugin packaging, synthetic-root guards, incremental evidence
ledgers and fixed-bundle preparation/dispatch safeguards. Network calls in tests
are mocked; valid quotes are **not** a score for architectural truth.

## Question-led prototype (offline first)

[Offline results and limits](RESULTS-questions-offline.md) describe the first local
question/evidence/follow-up smoke. `explore.py` is a lexical evidence ledger, not a
semantic search tool or autonomous surveyor. It makes no model calls and does not
change inspected sources. Keep its state outside a synthetic source root:

```sh
printf '%s\n' '{"questions":[{"text":"How is a record revision assigned?","anchors":["revision","submit"]}]}' |
  python3 -B eval/surveyor/explore.py --root eval/surveyor/cases/revision --state /tmp/sessionkit-explore-demo.json
```

Reuse that state with `focus` containing returned node IDs and new questions.
Source changes reject follow-up; remove obsolete temporary state and start fresh.
Claims/typed relationships can be recorded as `action: record` with a `proposal`
containing `question_id`, `claim`, known `evidence` IDs and optional `counterevidence`.
Relationships require two known `endpoints`; every proposal stays unverified.
The default limits bound retrieval, not all local verification I/O. This is not a
sandbox or a comprehensive sensitive-content filter: use synthetic fixtures only.

The separate `QUESTIONS.md` model treatment asks an agenda through existing native
Jev tools. It is not connected to this ledger; no production `explore_repo` exists.
An optional paid run (not executed in the offline pilot) is:

```sh
python3 eval/surveyor/run.py --variant survey --strategy questions --case revision --tool-profile sessionkit
# Control: same inventory, read-led strategy. Counterbalance order in repetitions.
python3 eval/surveyor/run.py --variant survey --strategy read --case revision --tool-profile sessionkit
```

The question-led condition prescribes native-tool use, not spontaneous adoption.
Tool-selection guidance and research order change together. See cost warnings below
before dispatch; the Claude cutoff does not cap Jev spend.

## Fixed large question bundles

[Completed real-repository pilot](RESULTS-bundles.md): three paid requests each
answered 56 typed questions. The sanitized result separates batching integration,
category review, incomplete evidence and counterexample failures. Raw private
sources/results remain outside this repository. Research basis and next-tool
boundaries: [Jev codebase-mapping notes](../../docs/jev-codebase-mapping.md).

`bundle.py` defines 28 propositions (16 base questions and a deliberately selected
12-question version-workflow module), each with a separate source-evidence Choice:
56 questions share one file state in one request. This is a detection protocol,
not free-form exhaustive architecture extraction. Domain modules are not universal.

`run_bundle.py` is an experimental three-file allowlisted pilot, bypassing the
production CLI/native-tool ten-question restriction without changing that limit.
Default invocation prepares payloads, source/protocol hashes, a preselected
review subset and a conservative cost estimate OFFLINE. `--execute` sends the
prepared sources to TypeSafe and incurs payment. It requires prior explicit
approval of the exact source files/provider and cost assumptions. Never read a
project `.env` for credentials; existing environment/SessionKit Keychain only.

Artifacts must be outside both the inspected and SessionKit repositories. Raw
source-bearing requests, responses, evidence maps and review reports remain
private, are not committed, and must not be published with public evaluation docs.
The pilot uses a $0.02 estimate boundary at the local input-only tariff; this is
not a provider billing guarantee. Three calls maximum, no retries/resumption;
uncertain failures, missing usage or source/model changes stop the run.
Selected evidence is a lead, not semantic verification. A broad universal claim
can miss an update elsewhere even with a valid quote. Keep provider confidence
separate from chosen-option probability and evaluate counterexamples explicitly.

## Optional paid model comparison

Requires Claude Code and its normal authentication. This deliberately makes paid
Claude model requests (API-equivalent cost also reported for subscriptions):

```sh
python3 eval/surveyor/run.py --variant both --model sonnet --effort low
# Counterbalance order across repetitions; not a substitute for held-out repos:
python3 eval/surveyor/run.py --case transfer --variant both --repeat 2
# Select one case: development (default), snapshot or revision; all runs all three.
python3 eval/surveyor/run.py --case revision --variant survey
# Same procedure with/without only the native SessionKit tools:
python3 eval/surveyor/run.py --variant survey --case tooling --tool-profile both
```

The runner copies only the selected synthetic case into a fresh temporary project, never gold
labels or evaluation files. It places just the method references beside it. It
turns off auto-memory, explicitly disables installed plugin IDs, restricts tools
to Read/Glob/Grep by default, disables session persistence and external MCP, and detects unexpected
plugins/tools and changed fixture files. Native host behavior is not sandboxed;
this is not an OS-level filesystem boundary. Do not pass client code to this toy
runner. Runtime execution and browsing are not offered. The optional sessionkit
tool profile adds only the production search module in a temporary plugin; its
native tools invoke real paid Jev-backed grep/ask, restricted to synthetic source.

Default timeout is 180 seconds and Claude budget $2 per run. Bounds are CLI-level,
not a guarantee on billing; a timeout/cutoff is an incomplete run. The Claude
budget does not cap Jev calls. The native CLI proxy has a 115-second timeout;
unknown/incomplete Jev usage stays unknown, never silently zero. Output defaults
to a private system temporary directory, not committed eval/results. Reusing an
existing run directory fails rather than overwriting evidence.

Artifacts per run: prompt.txt, output.jsonl, stderr.txt, report.json, metadata.json,
and candidate method snapshots under method/. Native runs also have jev.jsonl,
recorded tool inventory/selection, production search-module hash and (in future
runs) CLI version/binary identity.
Raw streams may include host metadata; keep them local, do not publish them.
Metadata records exact fixture/prompt hashes, version, resolved model usage,
source-tool counts, output characters, elapsed time and Claude dollar estimates.
Method/schema/rubric hashes identify the frozen evaluation version; gold labels
are hashed locally but not passed to the model.
Temporary source paths make the prompt hashes differ across runs; saved prompts
and source hashes preserve what each run actually saw. Tool counts are measured
from unique stream call IDs, not the model's self-report. CLI journals distinguish
reported ask cost estimates from unknown grep/failure costs; combined estimates
are null when Jev cost is incomplete.

```sh
python3 eval/surveyor/check.py /path/to/report.json
# For a transfer case, use the corresponding source root:
python3 eval/surveyor/check.py /path/to/report.json --root eval/surveyor/cases/revision
```

Exit 0 means citation/structure checks pass, **not** a semantically correct survey.
Exit 2 indicates invalid/incomplete/contaminated output. check.py is a local
validator of model output; it does not repair a report or silently rerun a model.

## Human semantic review

For each rubric fact, mark supported / partial / missed / wrong and identify
claims and evidence. For every claim, distinguish factual support, sufficient
citations and appropriate standing. Search for counterexamples (including state
preconditions), not just matching words. Classify questions as useful intent,
factual, bundled or unsupported. Do not let a good quote, a convincing diagram
or a single aggregate number hide unsupported assertions.

### Latest fixed-bundle pilot

[Results](RESULTS-bundles.md) document actual shared-state batching on a manually
selected real-project slice. There was no autonomous agent, adaptive paid follow-up
or read-led control. Use this as development evidence, not a promotion benchmark.

### Latest tool comparison

[Native-tool results](RESULTS-tools.md): four unforced paired runs advertise the
tools but never select them, including an inert-padding read-size diagnostic.
A separately forced two-tool smoke verifies real CLI dispatch but is not evidence
of spontaneous adoption. No onboarding or user plugin settings changed.

### Previous method iteration

[The v2 comparison](RESULTS-v2.md) has eight counterbalanced transfer runs and an
original-development regression pair. The candidate now states the conditional
rename behavior explicitly, but still fails one citation check and misses an
identity-reuse cache counterexample. **Onboarding remains unchanged.** The
semantic review is the implementing assistant's source/oracle analysis, not an
independent expert assessment. No automatic truth score is inferred.

### Historical first clean pair, 2026-10-06

Claude Code 2.1.291, resolved model Sonnet 5.5, low effort, one run per condition:

| Measure | Adapted legacy | Candidate survey |
|---|---:|---:|
| Source-tool calls | 11 | 13 |
| Tool-output characters | 4,457 | 7,478 |
| Elapsed seconds | 25.18 | 29.43 |
| Claude API-equivalent dollars | 0.060845 | 0.068283 |
| Citation mechanics | pass | fail: wrong range on one Compose quote |

Qualitative review against source:

- Both identify the important launch paths, SQLite jobs, direct-write bypasses,
  environment override, stale docs and inactive prototype. The candidate makes
  the ordinary request flow more explicit; neither has a demonstrated recall win.
- The candidate scopes runtime/inactive-use uncertainty more carefully, but its
  third question bundles prototype plans and actual CLI deployment. The legacy
  questions are more focused on ownership and index consistency.
- Both overgeneralize the rename effect. Rename does not enqueue a new job, but
  an **existing pending job** joins the current item text and can publish its
  renamed value. Neither supports a blanket 'renamed items are never published'
  conclusion. This counterexample is not one of the eight original rubric labels;
  it is a discovered error, not a post-hoc increase to their coverage denominator.
- Both self-report tool counts incorrectly. The measured stream counts above are
  authoritative. Reading every file also does not establish complete behavior.
- The candidate's extra reference reads add context in this tiny project. Costs
  also depend on cache/order; this single pair cannot establish a cost effect.

An earlier pair was rejected because plugins still loaded despite empty setting
sources. The runner now disables installed plugin IDs explicitly and rejects any
remaining contamination. Those runs are not counted as comparison evidence.

**Conclusion: do not promote or reroute onboarding yet.** The candidate is not
proven better and fails the citation gate on this pair. Next work: verify exact
ranges, check behavior preconditions instead of broad negative conclusions, avoid
model-reported counts, and build a genuinely held-out, less signposted corpus.
Repeat/counterbalance before drawing claims about precision, coverage or cost.
No raw model transcript or user conversation is included in this repository.
