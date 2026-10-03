<!-- sessionkit architect: baseline bc2d198 2026-10-03 -->
# Architecture

## System shape
One Rust binary (`sessionkit`, `src/main.rs` dispatches subcommands, no library crate) plus a Claude Code plugin of JS function hooks (`plugin/`) that is embedded in the binary and written out by `sessionkit setup`. [observed]

Rust modules (`src/`):
- `start` - choose context from earlier sessions with Jev and start claude/codex/jcode (largest module, 1594 lines). [observed]
- `usage` - local, free token and cost analysis of transcripts. [observed]
- `pricing` - built-in price table (ADR 0004). [observed]
- `cache` - prompt-cache cost and warmth arithmetic over transcripts. [observed]
- `transcript` - format of a transcript entry; not where transcripts are found (ADR 0003). [observed]
- `claude` - status line and the settings-file hooks (`hook session-start|prompt|architect-check`), the wiring into Claude Code. [observed]
- `next`, `peers` - close a cold session into a fresh one; list running sessions and fit a task to a warm one. [observed]
- `compact`, `trim` - compaction without summary; measurement of cutting large tool results. [observed]
- `skills`, `measure` - find repeated work; measure `start`'s selection. [observed]
- `ask`, `grep/` - ask about a file; find code by asking Jev (`grep/` is a jevgrep port, with its own Jev client, ADR 0001). [observed]
- `jev` - the shared System One client (one request, batch, Choice, estimate mode). `auth` - TypeSafe key from env, Keychain or 1Password. [observed]
- `architect` - classifier that decides whether a change wakes the architect agent (ADR 0005). [observed]
- `js` - small helpers for `serde_json::Value` access, used everywhere. `setup` - installs status line, hooks, skill and plugin into `~/.claude`. [observed]

Plugin (`plugin/`): `hooks/index.js` registers the function hooks (`compact`, `fold`, `read`, `edit`, `effort`, `prompt`, `agent`, `repeat`, `architect`; `waiting.js` is shared); `agents/architect.md`, `skills/architecture`, `output-styles/robot.md`; `.claude-plugin/` manifests. `eval/` holds measurement scripts; `packaging/homebrew` and `.github/workflows/release.yml` build and publish via a Homebrew tap. [observed]

## Ownership
- Transcript entry format: `transcript`. Locating transcripts: four functions in four modules (ADR 0003). [observed]
- Jev requests: `jev` for everything except `grep/`, which owns its own client and policy (ADR 0001). [observed]
- TypeSafe key and its storage: `auth`. [observed]
- Prices: `pricing`. [observed]
- Persistent state: files only. `~/.cache/sessionkit` (`claude::cache_dir`: ack files, handoffs, `architect-checks.jsonl`), the macOS Keychain for the key, `~/.claude` for what `setup` writes. No database, no server. [observed]
- Architect memory: `ARCHITECTURE.md` and `docs/adr/` in the target repository, no state file (ADR 0005). [observed]
- Plugin hooks decide in JS and call the binary (`sessionkit hook ...`, `compact`, `ask`) for anything needing Jev or transcripts; JS never calls Jev directly. [confirmed]

## Dependency rules
- Leaves: `js`, `auth`, `pricing`, `transcript`, `grep/source`. `jev` depends only on `auth`, `js`. [observed]
- `usage` is the base for analysis: `start`, `compact`, `next`, `measure`, `peers`, `skills` depend on it. [observed]
- `trim` -> `compact` -> `start`; `skills` -> `measure` -> `start`; `ask` -> `grep::fs`. [observed]
- Every Jev or transcript need of plugin JS goes through the `sessionkit` CLI. [confirmed]
- A new Jev-using command uses `jev::post` or `ask_choice`; `grep/` is the only exception. [confirmed]
- Platform: macOS-only (Keychain, `ps`, Homebrew) is a current limit; new code should avoid deepening it. [confirmed]
- `eval/` is a measurement workspace outside these rules. [confirmed]
- Plugin modules import only each other (`compact`, `fold`, `prompt` share `waiting`/`compact`); the plugin reaches Rust only through the CLI. [observed]
- Rust side keeps no dependency on the plugin's JS except embedding it in `setup`. [observed]

## Principles
- Jev selects and judges; it never writes or summarizes; kept text stays verbatim. [observed, README]
- Commands that need no key run with no network (`usage`, status line, hooks). [observed, README]
- Architect advice never blocks; only decision or drift asks the person (ADR 0005). [observed]
- Two similar things stay separate when they differ in policy, not just in code (ADR 0001-0003). [observed]

## Decisions
- [0001](docs/adr/0001-grep-keeps-its-own-jev-client.md) grep keeps its own Jev client.
- [0002](docs/adr/0002-no-policy-module-for-cold-and-large-sessions.md) no shared policy module for cold and large sessions.
- [0003](docs/adr/0003-transcript-lookups-stay-separate.md) transcript lookups stay separate.
- [0004](docs/adr/0004-prices-are-a-built-in-table.md) prices are a built-in table.
- [0005](docs/adr/0005-the-architect-is-a-plugin-agent-woken-by-jev.md) the architect is a plugin agent that Jev wakes.

## Known debt
- AD-001: Module cycles (to be fixed soon). `claude` <-> `architect`, `claude` <-> `peers`, `start` <-> `next` (`src/claude.rs:20-26`, `src/architect.rs:15`, `src/peers.rs`, `src/next.rs`). Pre-existing at onboarding. Policy: warn on every change that touches these modules or edges; fix is planned. [confirmed]
- AD-002: `claude.rs` (922 lines) is a hub importing ten modules and mixing status line, settings hooks and the architect check; to be split soon. [confirmed] `start.rs` (1594) and `compact.rs` (1221) are similarly large [observed]. Pre-existing at onboarding. Policy: warn when a change adds a responsibility to `claude.rs`; no warning on unrelated changes to the others.
- AD-003: `usage::home` is a misplaced general helper [confirmed] that `claude`, `grep` and others reach through `usage` (`src/grep/mod.rs:109`). Pre-existing at onboarding. Policy: no warning unless a new module copies the pattern.

## Tensions
- Hook logic exists twice: settings hook `prompt` in `claude.rs` and plugin `prompt.js` (ADR 0002 accepts this). [observed]
- The architect feature is new and uncommitted at onboarding; its classifier, plugin hook and agent definition are one concept across Rust and JS. [observed]
- Embedding plugin files in the binary (`setup.rs:42-`) means every plugin file added must be registered in a list there. [observed]

## Deliberate exceptions
- `grep/evaluator.rs` separate from `jev.rs` (ADR 0001). [confirmed by ADR]
- Four transcript lookups (ADR 0003). [confirmed by ADR]
- Settings hook and plugin hook each decide cold/large sessions (ADR 0002). [confirmed by ADR]

## Open questions
- Should `start.rs` and `compact.rs` be split too? Only `claude.rs` is confirmed.
