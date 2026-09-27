# Changelog

All notable changes to jev-start. The format follows [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

### Added

- **Session chains.** When jev-start starts Claude Code, it gives the new session a known id
  and notes in `~/.cache/jev-start/chains.jsonl` which sessions it came from. A later run then
  offers the newer session instead of the older one, with the higher relevance of the two,
  and its context points to the context file the newer session began with.

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

[Unreleased]: https://github.com/Calq-dev/jev-start/compare/aa905ef...main
[0.2.0]: https://github.com/Calq-dev/jev-start/compare/55fb775...aa905ef
[0.1.0]: https://github.com/Calq-dev/jev-start/commits/55fb775
