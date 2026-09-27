# Changelog

All notable changes to sessionkit, called jev-start before 0.3.0. The format follows [Keep a Changelog](https://keepachangelog.com).

## [0.6.0] - 2026-09-27

### Added

- **Usage limits in the status line on a subscription.** When Claude Code sends `rate_limits`,
  the status line shows the 5-hour and 7-day limits instead of dollars, and an estimate of what
  one call takes from the 5-hour limit at the current context. sessionkit learns that estimate
  locally from how the limit rises per call; it shows after 5 calls.

### Changed

- The status line says `context` instead of `ctx`.

## [0.5.0] - 2026-09-27

### Added

- **`sessionkit setup`** puts the status line and both hooks in `~/.claude/settings.json` with
  the path where sessionkit is installed: backup first, other settings and hooks untouched,
  safe to run again, asks before replacing another status line, `--remove` to undo.
- **Install with npm**: `npm install -g github:Calq-dev/sessionkit` gives the `sessionkit`
  command.

## [0.4.0] - 2026-09-27

### Added

- **`sessionkit statusline`** for Claude Code: context, cost per call, how long the prompt cache
  stays warm, and what the first call costs once it is cold. It uses Claude Code's
  `prompt_cache` and `context_window` fields, and the transcript before the first response.
- **`sessionkit hook session-start`**: on `--resume` or fork, a warning before the first
  message when writing the expired cache again costs more than $1.
- **`sessionkit hook prompt`**: stops a message to a cold session once when writing the cache
  again costs more than $2; sending it again goes ahead.

## [0.3.0] - 2026-09-27

### Added

- **`sessionkit usage`**: where the tokens and the money go in your Claude Code sessions, by
  kind of token, model, main sessions against subagents, project and session, with cold cache
  rebuilds and sessions that are cheaper to restart. Local and free. It counts tokens from the
  transcripts and prices them itself, because Claude Code's `cost-state` counts per process.
- **A cost estimate before spending.** `start` and `measure` first run dry: no network,
  neutral answers, the largest sessions where the real run picks by score. They print an upper
  bound, and ask above $0.05 (`SESSIONKIT_CONFIRM_ABOVE`); `--yes` skips the question.
- **`sessionkit measure`.** It plants turns with a known label into cut sessions and checks
  routing with cut sessions, so a run needs no hand work. The README has the first run.
- **Session chains.** When `start` starts Claude Code, it gives the new session a known id and
  notes which sessions it came from. A later run then offers the newer session instead of the
  older one, with the higher relevance of the two, and its context points to the context file
  the newer session began with.

### Changed

- **Renamed from jev-start to sessionkit**, with subcommands: `sessionkit start` (the old
  behaviour, and the default for a bare prompt), `sessionkit usage` and `sessionkit measure`.
  The cache moved to `~/.cache/sessionkit`, the keychain service to `sessionkit` and the
  variables to `SESSIONKIT_*`. The old names still work.
- `start` continues a session on its own at 0.7 instead of 0.6. Measured: three of three right
  above 0.7, one wrong at 0.67.
- At most eight open items are shown, the strongest ones. Measured: 11% of real blocks read as
  open, about fifteen per session.

## [0.2.0] - 2026-09-27

### Added

- **Jev decides the mode.** Without `--session`, `--pick` or `--search`, Jev chooses between
  the five best sessions and "new topic". A clear continuation (0.6 or higher) continues that
  session; a possible one (0.3 to 0.6) asks you; otherwise jev-start searches. `--search`
  always searches.
- **Rules and open items at the top of a continuation.** Jev asks per turn whether the
  request states a lasting rule or preference, and per block of a conclusion whether it is
  still open. Both need 0.7 or higher and appear verbatim.
- **What changed since the session**, from git: the branch now, the commits after the
  session, the uncommitted changes, and which files of the session changed afterwards.

### Changed

- When the current folder has no sessions, jev-start searches every project, so it works
  from any terminal.
- Turns in a continuation are numbered, so the rules and open items point to them.

## [0.1.0] - 2026-09-27

First release.

### Added

- **Search earlier sessions.** `jev-start "prompt"` asks Jev which Claude Code sessions worked
  on the subject of the prompt, then which of their exchanges help. The kept exchanges go
  verbatim into the new session, within about 6k tokens. `--all` searches every project.
- **Continue one session cold.** `--session <s>` takes an id, an id prefix, `last`, or words
  from the title. `--pick` shows a numbered list of recent sessions in every project, with
  the ones from this folder first. Jev sees the whole session as an outline, with your
  prompt plus the last three prompts of the session as the goal. The context holds the last
  compaction summary, the first and last turns, the turns that still apply, the files the
  session changed, and its last commands. The agent starts in the session's folder.
- **Three agents.** `--agent claude|codex|jcode`, or `JEV_START_AGENT`:
  - Claude Code gets the context with `--append-system-prompt-file`.
  - Codex gets it as `developer_instructions`.
  - jcode takes no first prompt, so jev-start sends the first message to the new session by
    its id once it is live. The message is also on the clipboard as a fallback.
- **The TypeSafe key** comes from `TYPESAFE_API_KEY`, else the macOS keychain, else once from
  1Password, after which the keychain holds it. A refused key is read again from 1Password.
- `--dry-run` prints the context and the agent command. `--verbose` prints the Jev score of
  every session or turn.
- A README with usage, how the selection works, the key, and what leaves your machine.

[0.6.0]: https://github.com/Calq-dev/sessionkit/compare/b770c59...main
[0.5.0]: https://github.com/Calq-dev/sessionkit/compare/444dd74...b770c59
[0.4.0]: https://github.com/Calq-dev/sessionkit/compare/2d6dd9e...444dd74
[0.3.0]: https://github.com/Calq-dev/sessionkit/compare/aa905ef...2d6dd9e
[0.2.0]: https://github.com/Calq-dev/sessionkit/compare/55fb775...aa905ef
[0.1.0]: https://github.com/Calq-dev/sessionkit/commits/55fb775
