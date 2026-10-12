# Backlog

Product ideas and reported problems. These are not accepted architecture decisions
or verified provider capabilities.

## Delivery status

Implemented in the working tree:

- Per-agent cache-write/rebuild reports, JSON output and isolation tests
  ([details](subagent-cache.md)). No automatic TTL change.
- Linux Secret Service credentials, portable setup smoke tests, Ubuntu CI and
  Linux release target ([installation](linux.md)).
- Shared Jev/Decisions/Clef adapters, search cache isolation, selected-provider
  credential checks and fake-server HTTP tests ([details](decision-providers.md)).

Still open: the friend's specific Ubuntu error/reproduction, desktop-keyring and
real Claude-hook checks on Ubuntu, broader Decisions/Clef quality calibration,
and verified API/access information for Perplexity/Microsoft. Default Decisions/Clef
schemas and synthetic ask/search workflows have now passed paid live checks
within the user-approved $1 budget. These are not
represented as completed integrations. See `implementation-status.md` for test
results and external blockers.

## Subagent cache rewrites

Make cache costs and suspected cold-cache rebuilds visible per individual Claude
Code subagent. Main-session cache monitoring and aggregate subagent costs already
exist, but do not fully expose this pattern.

- Analyze each subagent's own call timeline, observed cache-write TTL, idle gaps,
  cache reads/writes and API-equivalent costs.
- Keep expiry detection heuristic: prompt-prefix changes can also cause rewrites.
- Verify Claude Code support for `subagentPromptCacheTtl` and
  `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` before recommending either.
- Prefer evidence-based, opt-in advice over automatically changing settings or
  adding keep-alive polling. Do not equate API-equivalent costs with subscription
  quota consumption.

## Ubuntu support

User report: a friend working on Ubuntu could not use SessionKit. The failing
command, installation method, error output and Ubuntu version are not yet known.
The README currently describes macOS as the tested installation path.

- Reproduce the failure with the user's installation steps and error output.
- Audit installation, setup, credential storage and runtime dependencies for
  macOS assumptions; distinguish local usage analysis from authenticated features.
- Add an Ubuntu smoke test and a documented supported installation path.
- Make unsupported operations fail with actionable guidance rather than leaving
  the integration unusable.

## Multiple decision-model providers

Explore supporting more than Jev/TypeSafe for decision-model functionality. The
user reports a rapidly growing market and mentions Cloudflare Clef, an OpenAI
Decision API, Perplexity and Microsoft as research leads. Exact product names,
availability and capabilities still need verification.

### Existing local research to reuse

Start with `../lmnl/research/2026-10-07-agentische-toetsing/decision-models/`:

- `README.md`: provider payloads, normalization, costs and verification limits.
- `run.py`: implemented research backends for Jev, OpenAI Decisions and
  Cloudflare Clef; request construction and answer normalization.
- `test_decision_models.py`: local fake-server tests, without paid calls.
- `TUNING.md`, `variants.py`, `tune.py`, `report.py`: evaluation and tuning work.

Also see `../lmnl/research/2026-10-10-beslismodellen/beslismodellen.html` for
market context and the motivation for decision models. These sibling paths are
local research references, not SessionKit runtime dependencies.

The runner README explicitly lists unverified live response shapes and missing
credentials/quota for some backends. Reuse the research rather than starting from
scratch, but distinguish implemented adapters from live-verified integrations.

### Next steps

- Inventory the existing decision-model calls and their required capabilities.
- Review the local lmnl adapters and evaluations before designing new ones.
- Research provider APIs, structured outputs, confidence semantics, latency,
  pricing, authentication and data-handling policies.
- Design a capability-aware provider boundary: do not assume every provider can
  replace every Jev use case, or that confidence scores are interchangeable.
- Keep provider selection and credentials explicit; do not silently send project
  data to fallback providers.
- Evaluate providers on the same representative tasks before choosing defaults.
- Record an ADR once the requirements and proposed boundary are grounded in
  actual integrations, rather than committing to an abstraction prematurely.
