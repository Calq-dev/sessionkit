# Platform, cache and decision-provider delivery status

## Implemented

- Linux Secret Service login/logout/status for TypeSafe, with environment-key
  precedence and actionable headless/keyring guidance; no plaintext fallback.
- macOS/Ubuntu Rust CI, isolated install/remove/idempotence smoke test, Linux
  credential-helper contract test and Linux x86_64 release job.
- Optional Linux clipboard helpers for jcode; absent clipboard does not block launch.
- Individual subagent cache-write totals, suspected rebuild events and conservative
  longer-TTL hints in usage text/JSON. Main-session totals retain their meaning.
- Explicit Jev/Decisions/Clef adapters used by shared decision workflows and search,
  with selected-provider credentials, strict answer validation, separated search
  cache namespaces and local HTTP contracts. Jev remains the default.
- Documentation: `linux.md`, `subagent-cache.md`, `decision-providers.md`, ADR 0006,
  README and changelog updates. Existing uncommitted work was preserved; no commit,
  release or real user setup change was performed. Subsequently, the user approved
  paid synthetic live checks with a $1 total cap; see results below.

## Local OpenRouter switch

The installed CLI on this machine was subsequently rebuilt and updated (with a
backup of the previous binary), and a credential-free local preference selects
`openrouter` / `~typesafe/jev-latest`. The OpenRouter key was read in memory from
1Password and stored separately in macOS Keychain. Existing TypeSafe credentials
were not removed. Installed plugin hooks already invoke this CLI path, so their
next CLI calls inherit the saved provider preference unless explicitly overridden
by environment variables. No plugin reinstallation or merge was performed.

OpenRouter's native `https://openrouter.ai/api/v1/systemone` returned HTTP 200 on a
synthetic probe; its response reported a cost of $0.000012054 for that probe.
The installed **production** binary then passed positive/negative predicates,
a Choice and code search with provider/model/key environment overrides removed,
using the saved configuration and Keychain. The model remains Jev from TypeSafe,
but these requests use OpenRouter credentials and billing, not direct TypeSafe
credits. No real project code was submitted for these tests.

OpenRouter was added to the fake-server contracts, with saved-config selection,
environment precedence and fail-closed invalid-config checks. Linux smoke tests
also cover separate OpenRouter credential storage/logout without removing a
TypeSafe key. Latest local macOS/Ubuntu Rust tests: **108 passed**, and the extended
HTTP and Ubuntu credential/setup smokes passed.

## Verification completed locally

| Check | Result |
| --- | --- |
| macOS `cargo test --locked` | 107 passed after live-protocol regressions |
| macOS `cargo test --locked --features test-api` | 107 passed |
| macOS CLI installation smoke | passed |
| macOS three-provider HTTP contract smoke | passed |
| Linux Debian container Rust tests / both smokes | passed |
| Ubuntu 22.04 container Rust tests / both smokes | 107 passed after live-protocol regressions; both smokes passed |
| Survey evaluator unit tests | 40 passed |
| `git diff --check` | passed |
| Clippy, all targets with test-api | completed; warnings remain in the working tree |
| Claude Code 2.1.296 plugin tests | 87 passed, 2 failed |

The two plugin failures are outside the changed provider/search modules:
`architect.test.ts` expects a fallback main-conversation note after an ended
loop; `permission-probe.test.ts` has a `ui.log` test hook returning no result.
They are recorded, not silently marked passing or fixed by altering the user's
existing architect/permission work. The search-tool tests passed.

Container tests use synthetic transcripts and a fake Secret Service helper, not
an unlocked real desktop keyring. The Ubuntu run was performed locally, not
claimed as a completed GitHub Actions run. Release assets have not been published.

## Remaining external checks / blockers

1. Obtain the friend's Ubuntu version, installation path, failing command and
   exact error to reproduce the original problem. Portable tests cannot prove a
   fix for an unspecified failure.
2. Verify `secret-tool` against an actual Ubuntu desktop keyring and real Claude
   function hooks; containers do not provide those facilities.
3. Broader SessionKit task quality/calibration remains open, but live default-model
   schema and CLI smoke checks are now complete. The user approved the development
   OpenAI key and Calq B.V. Cloudflare account with a $1 total cap. Credentials were
   loaded in memory from 1Password / the existing Wrangler OAuth login. Both
   providers passed a positive predicate, negative control, Choice and two-file
   search oracle on synthetic code. The final run made 12 requests, with a
   usage-based research-price estimate of $0.001443; probes/reruns are additional,
   and conservative reservations across the recorded tests stayed below $0.01.
   No provider bill was retrieved. Decisions' null Choice-description rejection
   was fixed and regression-tested; live Clef result.usage is preserved, with
   envelope usage also supported. No real project data was used as model input.
   Replay fixtures: `eval/fixtures/decision-live-responses.json`. The local raw
   reports are under ignored `eval/results/decision-live-*.json`. These small
   smoke checks do not calibrate all Jev-derived thresholds or establish general
   quality parity.
4. Research confirmed API/capability/access information for Perplexity and
   Microsoft before implementing adapters; they are not currently supported.
5. Verify subscription-specific TTL controls before recommending a settings or
   environment-variable recipe. Local Claude changelog confirms setting names in
   2.1.243 for API-key/cloud users, not subscription behavior.

The three implementation tracks have working code and offline/container checks.
The overall agreement is **not fully closed** while these live/access and
original-failure checks remain outstanding.
