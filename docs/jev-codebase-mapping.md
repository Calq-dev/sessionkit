# Jev for question-led codebase mapping: research notes

Research snapshot: 2026-10-06. Status: experimental design and evidence synthesis,
not a production capability or a validated whole-repository survey method.

This complements [the as-built survey method](survey-method.md) and
[the evaluation index](../eval/surveyor/README.md). Onboarding remains unchanged.
No `/sessionkit:surveyor` command or production `explore_repo` tool exists.

## Provenance and evidence levels

The supplied `Jev-Codebase-Mapping-Research.md` was read completely. Its SHA-256
is `e99e5e34b8b33e3a270b1a3726c3f235c39b2b6523b8822084b9c307d6df4240`.
It reports reviewing 111 indexed TypeSafe documentation pages and selected
community implementations. That is the supplied report's scope, not a claim
that SessionKit independently repeated that entire review. The source document
is not copied into this repository; local paths and conversations are omitted.

Distinguish:

- **Documentation/reported specifications:** primitives, shared-state batching,
  context, prices, confidence and operating limits below. Primary URLs are supplied
  for checking; this pass did not independently re-fetch all of them.
- **Author-reported demonstrations:** official cookbooks and community projects
  illustrate algorithms, not production repository coverage or independent accuracy.
- **Our measurement:** a [three-file fixed-bundle pilot](../eval/surveyor/RESULTS-bundles.md)
  actually dispatched paid requests. It tested batching and source-local judgments,
  not autonomous exploration or superiority over a read-led survey.
- **Our design inference:** the proposed research loop and integration boundaries
  are hypotheses to evaluate before promotion.

## Division of labor

Jev makes bounded semantic decisions over supplied textual state; it does not
write explanations or architecture documents. Local code inventories/parses
sources, enumerates candidate symbols and spans, schedules requests, validates
source identities, enforces budgets and renders results. The survey agent chooses
consequential unknowns, connects evidence across files and formulates conclusions.
See [coding-agent integration](https://docs.typesafe.ai/introduction/coding-agents).

Navigation relationships and source mentions are not automatically runtime calls,
active registrations, complete dependency paths or validated architecture facts.

## Fixed protocol, selectively loaded modules

Do not make the agent reinvent the basic investigation agenda for every file.
Use one versioned protocol with:

1. **Base questions:** inputs/outputs, responsibilities, reads/writes, delegation,
   failure handling and observable preconditions.
2. **Selected mechanism modules:** queues, cache identity/revision, storage,
   registration/configuration, external interfaces and test scope.
3. **Counterexample/evidence questions:** which concrete branches, fields and
   source locations support or defeat the exact proposition?
4. **Dynamic follow-up:** questions arising from interactions between particular
   findings, rather than another generic checklist round.

These are shared research resources, not new project skills or persistent memories.
Modules are research lenses, not requirements that a repository must implement.
The current `bundle.py` pilot has 16 base propositions plus a deliberately chosen
12-proposition version-workflow module, each paired with evidence selection.
It is a closed-set detection protocol, not exhaustive responsibility extraction.
Automatic role/module selection is not yet implemented.

## Batching and dependency between questions

Several questions share one state in a request. Each is evaluated independently:
none can use another answer from that same request. Ask explicitly about the target
field/snippet in the instructions; question IDs are bookkeeping, not inference
context. Independent evaluation does not imply independent errors.

Known counterquestions can be speculatively included in the same batch. A new
question that depends on the returned answer or another file needs a subsequent
request. Batch around shared evidence; concurrency across distinct file states
is a separate optimization and does not eliminate their input cost.

Sources: [primitives](https://docs.typesafe.ai/primitives),
[fan-out](https://docs.typesafe.ai/patterns/fan-out),
[parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions).
The cookbook's reported speed/cost ratios use a sequential baseline; do not treat
our single bundled run as a reproduction or as a concurrent-client comparison.

## Primitive choice and operating envelope

- **Noul:** probability for a binary proposition. Separate properties that can
  coexist rather than forcing them into one mutually exclusive Choice.
- **Choice:** one option, option probabilities and derived confidence; include
  `none`/unknown where the supplied alternatives may not establish an answer.
  Up to 255 options are reported by the reference.
- **Score:** ordered descriptive levels (2–10), not automatically a vulnerability
  probability or exact severity scale.

The supplied review reports `jev-1.13.0`, input pricing $0.042/M tokens with output
free, and context bounds of 64k tokens for state plus all questions and 32k for
state plus the longest question. This corrects an earlier oversimplified 32k-only
assumption. Published request/token rate ceilings are changeable, not latency SLAs.
Pin the actual model and recheck current specifications before new integrations.
Sources: [models](https://docs.typesafe.ai/models),
[API](https://docs.typesafe.ai/api), [Choice](https://docs.typesafe.ai/primitives/choice),
[Score](https://docs.typesafe.ai/primitives/score), [Noul](https://docs.typesafe.ai/primitives/noul).

For Choice, the reviewed confidence formula is `(p - 1/n) / (1 - 1/n)`, where p
is the winning probability and n the option count. Confidence and p are not two
independent confirmations. Retain both for traceability, but do not combine them
as separate verification votes. Calibration, repeatability and correctness are
also distinct. Source: [confidence](https://docs.typesafe.ai/confidence).

## Retrieval, evidence and uncertainty

The transferable recipes are:

- Local parsing/signatures and keyword retrieval generate candidates cheaply.
- Hierarchical exploration retains alternatives rather than pruning to one branch.
- Jev separately judges query relevance, evidence support and possible conflict.
- Code checks exact source membership/ranges before semantic support is assessed.
- An answer-exists check or `none` avoids a forced winner becoming a false finding.

Relevant references:
[hierarchical classification](https://docs.typesafe.ai/cookbooks/hierarchical_classification),
[semantic find](https://docs.typesafe.ai/cookbooks/semantic_find),
[reranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe),
[RAG passage classification](https://docs.typesafe.ai/cookbooks/classifying_rag_passages),
[citation checking](https://docs.typesafe.ai/cookbooks/citation_check),
[pre-parsed extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook).
Their illustrative/non-code datasets do not establish code-survey accuracy.

The supplied review discusses the attack-surface scanner, JevFind, graphify-jev
and Jev Scout. These help distinguish host parsing, semantic prioritization and
agent reasoning; their existence or authors' cost reports are not independent
benchmarks. A scanner that operates without Jev calls supplies no Jev latency
measurement. An unavailable referenced project is not confirmed evidence.

Measure recall after every pruning stage, including rejected/skipped candidates.
A reranker cannot recover a correct source removed from its candidate set. A
selected source window can be verbatim yet miss the branch that defeats a broad
claim. A local reference does not prove multi-hop behavior or complete coverage.
See the reported [model limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13).

## Proposed incremental exploration loop

```text
research question + minimal scope
  -> local candidate discovery
  -> selected fixed question bundles over shared source
  -> source-bound evidence / hypotheses / counterevidence
  -> highest-impact unresolved question
  -> focused neighboring-source or caller/configuration checks
  -> supported proposal or explicit remaining unknown
```

No exhaustive semantic pre-index is required. Maintain temporary exploration
state with inspected content hashes, exact spans, protocol/model identity,
probabilities, usage, exclusions and open questions. Source changes invalidate
affected evidence. A git commit alone does not describe uncommitted file contents.
The current offline ledger binds only inspected files, not a full repository.

Do not promote this state into a parallel knowledge archive. Only accepted concise
conclusions may enter the existing `ARCHITECTURE.md`, after explicit calibration
and write approval. As-built shortcuts do not become architectural policy or debt.

## Operational and promotion boundaries

Source transfer and paid calls require explicit approval/disclosure and enforced
source selection. Provider SDK retries and timeouts need deliberate budgeting;
uncertain failures must not silently trigger duplicate spending. Debug request
bodies can expose private code even if authorization headers are redacted.
See [Python usage](https://docs.typesafe.ai/sdk/python/usage) and
[retry behavior](https://docs.typesafe.ai/sdk/python/api/retries).

Keep private requests, source-bearing responses, graphs and review material out
of public docs. Return candidates rather than silently confirmed facts. A prompt
or typed schema is not a security boundary against repository instructions.

Next gates: refine operation/field scope, validate counterexamples and multi-span
support, integrate an explicit bounded exploration tool, compare actual read-led
and question-led workflows, and review transfer to unseen files/repositories.
Measure host plus Jev costs, reviewer burden and prefilter misses. Do not claim
savings when relevant usage is unknown. Production onboarding stays unchanged.
