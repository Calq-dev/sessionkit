# Decision-model providers

SessionKit defaults to Jev / TypeSafe. Set `SESSIONKIT_PROVIDER` explicitly to
select a different provider. There is no automatic fallback: source, transcript
or architecture data is sent only to the selected provider.

| Provider | Selection | Credentials | Default model |
| --- | --- | --- | --- |
| Jev / TypeSafe | `jev` (default) | `TYPESAFE_API_KEY`, stored key or configured 1Password fallback | `jev-latest` (search retains `jev-1.13.0`) |
| Jev via OpenRouter | `openrouter` | `OPENROUTER_API_KEY` or a separately stored OpenRouter key | `~typesafe/jev-latest` |
| OpenAI Decisions | `decisions` | `OPENAI_API_KEY` | `gpt-6-luna` |
| Cloudflare Clef | `clef` | `CLOUDFLARE_AUTH_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | `clef` |

**Decisions and Clef remain experimental quality-wise, but their default-model
protocols have now been live-tested** with synthetic predicate/Choice and search
workflows. Their model names and payloads follow the local lmnl research; the live
checks confirmed access to `gpt-6-luna` and `clef`. Broader calibration, provider
pricing and suitability for your tasks still need evaluation. Microsoft and Perplexity are research leads, not implemented backends.

```sh
export SESSIONKIT_PROVIDER=decisions
export OPENAI_API_KEY=...             # supply securely; avoid shell-history secrets
export SESSIONKIT_MODEL=gpt-6-luna    # optional; check your available models
sessionkit ask src/upload.ts "Does it retry failed uploads?"
```

The same provider selection applies to file questions, context selection and
compaction, routing/classification, architecture checks, workflow analysis and
semantic code search. Optional hooks only run when credentials for the selected
provider are at hand. `sessionkit auth` manages TypeSafe credentials by default;
OpenRouter has separate stored credentials via
`sessionkit auth login --provider openrouter`. Decisions/Clef use environment
credentials. Set environment overrides in the process that launches Claude Code,
then restart it to apply environment changes; the local preference file below
is read by each CLI invocation.

## Persist a local OpenRouter switch

```sh
sessionkit auth login --provider openrouter  # secure prompt; --stdin also supported
sessionkit auth status --provider openrouter
```

OpenRouter keys are stored separately from TypeSafe in Keychain / Linux Secret
Service. `OPENROUTER_API_KEY` overrides the stored OpenRouter key. OpenRouter auth
never falls back to TypeSafe credentials or invokes the TypeSafe 1Password
fallback. Logout with `sessionkit auth logout --provider openrouter` does not
remove TypeSafe credentials.

To select OpenRouter for the local machine without exporting shell variables,
create **`~/.config/sessionkit/decision.json`** (no secrets):

```json
{"provider": "openrouter", "model": "~typesafe/jev-latest"}
```

This preference applies to CLI calls and plugin-spawned processes. Explicit
`SESSIONKIT_PROVIDER` / `SESSIONKIT_MODEL` environment values take precedence.
A provider override does not inherit another provider's saved model. Invalid
configuration fails closed instead of making requests to the default provider.
Other machines without this file still default to direct Jev. Existing installed
binaries must be updated to use these adapters/preferences; changing only settings
cannot redirect an older hard-coded client. API endpoints remain fixed by the
provider implementation, not arbitrary user-supplied URLs.

## Protocol boundary

`src/decision.rs` owns provider selection, endpoint/model resolution, request
mapping and response normalization. Existing callers retain their retry,
concurrency and cancellation policies. Search retains its separate evaluator.

- Jev, Jev via OpenRouter and Clef use System One-style state and named questions.
  OpenRouter uses **`https://openrouter.ai/api/v1/systemone`**, not chat completions
  and not Jev Router (which routes chat requests to other models). The native
  `~typesafe/jev-latest` decision model was live-verified with a synthetic predicate.
- Decisions maps state to JSON text in an input message, Nouls to predicates and
  Choice criteria to named choices. Predicate criteria are included in the
  instructions; they must not disappear in translation.
- Responses normalize to named Noul probabilities and Choice distributions.
  Missing answers, duplicate names, invalid probabilities and incomplete Choice
  distributions are errors, not zero-probability evidence.
- Choice confidence is retained if supplied, but is not synthesized from the
  highest probability. Providers' confidence definitions may differ. Existing
  thresholds were developed with Jev and have not been calibrated for the other
  providers; provider substitution alone does not establish equivalent quality.
- Search cache identity includes provider, endpoint, model and adapter version.
  An answer from one provider is not reused for another.
- Only Noul/predicate and Choice are currently supported. Score and other
  capabilities need explicit adapter support rather than lossy translation.

Cost estimates use research defaults per million input tokens: Jev (direct or
via OpenRouter) $0.042,
Decisions $0.10, Clef $0.24, Clef-flash $0.09. These are **not current-price or
billing guarantees**; Clef-flash's research price was secondary-source only.
`SESSIONKIT_PRICE_PER_MILLION` overrides the estimate for a chosen model. Local
Claude usage pricing is separate and remains API-equivalent, not subscription
quota accounting. Some legacy CLI labels still say “Jev”; provider selection,
not those labels, determines the destination.

## Verification

```sh
cargo test --locked
cargo build --locked --features test-api
python3 eval/decision_smoke.py target/debug/sessionkit
```

The HTTP contract suite uses a local fake server and checks predicate, Choice and
search workflows for all three adapters, missing-answer rejection and unknown
provider rejection. `test-api` allows `SESSIONKIT_API` to override endpoints for
these tests; production builds do not expose this override.

Paid live checks were subsequently approved with a $1 total cap, using synthetic
input only. Both default providers passed a positive predicate, a negative
control, a Choice and a two-file search oracle. Decisions required string
Choice descriptions even for label-only choices; the adapter now supplies the
label instead of null. Clef live responses used `result.usage`; normalization
also supports envelope-level usage. Recorded live response fixtures provide
regression coverage in `eval/fixtures/decision-live-responses.json`.

The final oracle run made 12 requests with a usage-based research-price estimate
of $0.001443. Probes and development reruns were additional; conservative
byte-based reservations across the recorded runs and probes remained below
$0.01. These are estimates, not a retrieved provider bill. No real project code,
transcripts or secrets were submitted as model input.

The bounded harness is opt-in and requires an explicit output path:

```sh
cargo build --locked --features test-api
# Supply OPENAI_API_KEY, CLOUDFLARE_AUTH_TOKEN, CLOUDFLARE_ACCOUNT_ID securely.
python3 eval/live_decision_smoke.py target/debug/sessionkit --yes-paid \
  --max-cost 0.05 --report /tmp/sessionkit-live-report.json
```

It uses a local proxy to bound request size/count and reserve estimated costs;
it is not a provider-side billing limit. Credentials are environment-only and
not written to the report. Default-model smoke checks do not establish equivalent
quality across providers or calibrate all existing thresholds. Broader labeled
SessionKit evaluations must check false positives/negatives, abstention/confidence,
latency and actual usage. Do not treat lmnl's BgZ evaluation as a code-navigation
or compaction benchmark.

## Research provenance

Local sibling repository (not a runtime dependency):
`../lmnl/research/2026-10-07-agentische-toetsing/decision-models/` contains adapters,
fake-server tests, evalsets, tuning and documented verification limits.
`../lmnl/research/2026-10-10-beslismodellen/beslismodellen.html` explains the broader
market motivation. Consult those sources before adding further providers.
