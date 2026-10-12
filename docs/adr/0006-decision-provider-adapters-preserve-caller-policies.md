# ADR 0006: Decision-provider adapters preserve caller policies

Status: implemented; default-model synthetic live checks passed, broader quality calibration pending.

## Context

SessionKit needs to support multiple decision-model providers without duplicating
protocol translation across commands or silently moving project data between
services. The local lmnl research has Jev, OpenAI Decisions and Cloudflare Clef
adapters and documented response-schema verification limits.

Semantic search deliberately has its own evaluator, concurrency, retry and cache
policy (ADR 0001). Provider support is not a reason to erase that boundary.

## Decision

`src/decision.rs` owns explicit provider selection, endpoint/model resolution,
credential selection and request/answer translation for Noul and Choice.
`src/jev.rs` remains the shared caller-facing API for existing commands, while
semantic search uses the same wire adapters within its own evaluator.

Jev stays the default. No automatic cross-provider fallback is allowed.
Decisions/Clef credentials are environment-only for now. `auth` manages separate
TypeSafe and OpenRouter credentials; native Jev requests can route through
OpenRouter without consuming direct TypeSafe credits. A credential-free local
provider/model preference can override machine defaults, with environment values
taking precedence. Search cache identity includes provider, endpoint, model
and adapter version. Invalid or incomplete answers fail rather than becoming
false evidence. Unsupported question capabilities fail explicitly.

## Consequences

- Existing command policies and Jev model defaults remain in place.
- Decisions and Clef can be exercised through local HTTP contract tests without
  paid requests. Paid synthetic predicate/Choice and search smoke checks have
  since verified default-model live schemas; broader SessionKit quality and
  threshold calibration remain experimental.
- Confidence fields are retained, not invented. Provider-specific calibration
  and capability expansion require evaluation rather than assuming parity.
- Existing Jev-centric module names and some CLI labels remain technical debt;
  documentation makes the selected data destination explicit.
- Linux Secret Service support is separate credential storage work, not an
  excuse to persist new providers' secrets in plaintext configuration.
