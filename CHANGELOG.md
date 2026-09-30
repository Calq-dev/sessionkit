# Changelog

All notable changes to sessionkit, called jev-start before 0.3.0. The format follows [Keep a Changelog](https://keepachangelog.com).

## [0.16.0] - 2026-09-30

### Added

- **An Edit refused for an unread file is read and tried again.** Claude Code refuses an Edit of
  a file no Read in the session has seen, also when the agent read it with `cat` or `sed`, or
  before a compaction: 98 of 8,635 edits in the transcripts here, after which the agent mostly
  read the whole file again. The plugin now does that Read itself, through the engine, so the
  text stays out of the conversation, and retries the Edit, whose `old_string` must still match
  exactly once. Not for `replace_all` or Write.
- **Outline first for large files, an option.** With *Outline first for large files* on in
  `/config`, the first whole read of a file of 400 lines or more shows its first 20 lines and its
  declarations and headings with their line numbers; a second whole read gets all of it. Off by
  default until it is tried.
- **`sessionkit peers`: hand work to a warm session.** Lists the Claude Code sessions running on
  this machine, from `~/.claude/sessions`, with status, context, cache read per call and the time
  the cache stays warm. Given a task, Jev judges per idle, warm session whether its work covers
  the task (0.7 or more, not yet measured), and the output names the session to send it to with
  SendMessage. The skill tells the agent to run it before it spawns a subagent.
- **Warm peers in the shadow log of a subagent.** `hook agent-route` also logs, under
  `warm_peers`, the idle, warm sessions in the same folder and Jev's fit for the subagent's task.
- **`sessionkit usage --tools`: which tools fill the context.** Per tool the number and size of
  its results, the part in results above 10k and 20k characters, and how often later calls read
  them again from the cache, up to the next compaction. Only tool names and numbers, so the
  output can be shared; it decides what sessionkit trims next.
- **`sessionkit trim --measure`: would cutting large tool results early keep what is needed?**
  Splits large Bash and Read results in earlier transcripts into blocks, lets Jev judge them, and
  compares that with what the assistant used afterwards. On 150 results one Choice over the
  blocks reached an AUC of 0.61 inside a result, and a Noul per block ranked used blocks below
  unused ones, so nothing cuts results live.
- **`sessionkit trim --outline`: what an outline of a large file first would cost.** For every
  whole read of a file of 400 lines or more, it compares the file with an outline (the first
  lines, then every declaration and heading with its line number) plus the parts the assistant
  used afterwards. Local and free.

## [0.15.0] - 2026-09-30

### Added

- **The agent reports a /compact.** After a `/compact` that sessionkit did, a short prompt asks the
  agent to say, in the language of the conversation, that it worked, how many tokens the
  conversation went from and to, and how to go on. The numbers are Claude Code's own, from the
  compaction's boundary entry, which the new `hook compacted` waits for. Not after an
  auto-compaction, nor after a fallback to the summary.

### Fixed

- **After a compaction the cache state counts the compacted context.** The status line and the
  cold-cache check read the last call before the compaction, so after compacting a cold session
  of 912K tokens down to 39K the next message was stopped over the cost of writing 912K again.
  Now a compaction after the last call sets the context to what it left, and the cache to cold.

## [0.14.0] - 2026-09-30

### Added

- **The cold-cache dialog routes new work.** Before it asks, Jev answers the route question of
  `sessionkit start` with this session as the one candidate. When the message is clearly new
  work (0.7 or more for a new topic), the question says so, and a fresh session starts from the
  earlier sessions that fit the message instead of continuing this one. Otherwise, or without a
  TypeSafe key at hand, the fresh session continues this one as before.
- **Model routing for subagents, in shadow.** A function hook on `agent.spawn` asks Jev which
  model and effort level would have been enough for a subagent's task, and logs that beside the
  model it got in `~/.cache/sessionkit/agent-routes.jsonl`. It changes nothing. The choices are
  the Agent tool's aliases and effort levels, in Anthropic's own words from its model selection
  matrix and effort table.

## [0.13.1] - 2026-09-30

### Fixed

- **A fresh session no longer forgets a proposal from the last turns.** The conclusion of a turn
  was the last text the assistant wrote, so a proposal made earlier in the turn, before more tool
  calls, was lost. It now holds every text of the turn, plus the questions and options of
  `AskUserQuestion` and the plan of `ExitPlanMode`. A conclusion that is too long for a question
  to Jev keeps its start and its end instead of only its start, since a proposal sits at the end.

## [0.13.0] - 2026-09-29

### Changed

- **`sessionkit compact` asks about the output differently.** The question names the call's input
  and asks whether the work on its file or subject still goes on, and an output stays from 0.78.
  On held-out cuts it ranked outputs that came back above those that did not at 0.70, against
  0.56 for fast-jev-compaction's wording, which kept no output at all. The requests are no longer
  the same as fast-jev-compaction's.
- **`--measure` measures on a dataset.** `--measure build` labels Reads in every stretch between
  compactions, at any point auto-compaction could strike, by whether the file came back; cuts are
  split into train and test by session. `--measure run` compacts them and reports the ranking.
  `SESSIONKIT_COMPACT_WORDING` names a file with other wording to measure.

## [0.12.0] - 2026-09-29

### Added

- **A tip after the first large read.** When an agent reads a whole file of 400 lines or more, one
  line in its context says that `sessionkit ask` answers a question about a file without reading
  it, and `--find` names the line. Once per session and per subagent. Agents rarely used the
  tools: 1 to 2% of reads and searches, with MCP tools as well as with the skill.
- `sessionkit --version`.

### Fixed

- An unknown option to `sessionkit` or `sessionkit start`, such as `--version` before, started an
  agent with the option as its prompt, reading earlier sessions with Jev. It is an error now.
- `setup` names every hook of the plugin.

## [0.11.0] - 2026-09-29

### Added

- **A choice before a message to a cold session.** When the prompt cache has expired and writing
  it again costs more than the limit, Claude Code's own question dialog asks: continue in a fresh
  session, or here, with the cost in the question. Stop, or closing the dialog, puts the message
  back in the prompt box. A function hook on `prompt.submit` in the plugin that `setup` installs;
  without function hooks the settings hook acts as before.

### Changed

- `sessionkit grep` checks that a source is unchanged once per request, right before it is sent
  or its cached answer is returned, and waits up to 60 seconds for TypeSafe instead of 15; as
  jevgrep does since 0.4.3. The requests are the same.

## [0.10.0] - 2026-09-29

### Added

- **`sessionkit skills`** finds work you repeat across Claude Code sessions, where a skill would
  save time. Alike exchanges are grouped on the machine; Jev judges whether each group repeats
  one task, which installed skill already covers it, and which groups are the same task.
  `--draft n` starts Claude Code to write the skill; `--measure` scores random groups and split
  groups beside the real ones.

## [0.9.1] - 2026-09-28

### Fixed

- **`sessionkit ask` shows the answer.** Under every answer that is not a clear no stands the
  line that answers it. Before, an open question such as "where are the files of this client?"
  got only a probability and the question back.

## [0.9.0] - 2026-09-28

### Added

- **`sessionkit ask`** answers questions about a file without reading it into context: up to ten
  facts about one file (yes/no, or a choice with `--options`), one question over many files or
  folders (`--filter`), or the line that answers it (`--find`). A port of the ask-jev plugin;
  files with a sensitive name or a private key stay on the machine.
- **`sessionkit compact`** compacts a Claude Code conversation without a summary: Jev decides
  per tool call whether it and its output are still needed, all text stays verbatim. `setup`
  installs a plugin with a function hook, so `/compact` and auto-compaction use it, and turns
  function hooks on. A port of fast-jev-compaction (MIT) that sends the same requests.
  `sessionkit compact <session>` shows what it would keep; `--measure` measures the questions.
- **One skill, `sessionkit`**, for `grep` and `ask`, replaces the `sessionkit-grep` skill;
  `setup` removes the old one.

- **`sessionkit grep "question" [root]`** finds code by asking what it does: the relevant files
  with verbatim source and declaration locations, for a coding agent. A port of jevgrep
  (MIT) that asks Jev the same questions; compared with `jg` 0.4.2 it sends the same requests
  and prints the same output, about four times faster. Python is parsed with tree-sitter,
  TypeScript and JavaScript with oxc.
- **`sessionkit setup` installs the skill** in `~/.claude/skills`; `--remove` takes it out.

### Changed

- Retries to TypeSafe in `start` and `measure` wait with jitter, at most five seconds, and
  follow the server's `Retry-After`, as TypeSafe's SDKs do.
- `start` skips the copies of messages that a compaction without a summary writes after its
  boundary.

### Fixed

- The Homebrew formula installs inside Homebrew's sandbox, which cannot reach the `gh` login.

## [0.8.0] - 2026-09-28

### Changed

- **sessionkit is a Rust program now**, one binary without Node.js. It behaves as the
  JavaScript version did: on the same transcripts, `usage`, the status line, the hooks, `setup`,
  `next` and `measure` give the same output, and `start` sends Jev the same requests byte for
  byte. `usage` runs about ten times faster; the status line takes about 5 ms instead of 35.
- **Install with Homebrew**: `brew install calq-dev/tap/sessionkit`. The npm install is gone.
- `measure` writes its results to `~/.cache/sessionkit/measure/`.

### Fixed

- The status line no longer stops with an error on a model without a known price.
- `usage` gives a call that a forked session copied to the file that comes first, instead of
  to whichever file it read first.

## [0.7.0] - 2026-09-27

### Added

- **`sessionkit next`**: send `! sessionkit next "prompt"` inside Claude Code to close a session
  whose cache has gone cold and continue it in a fresh one, in the same terminal. It refuses
  while the cache is warm (`--force` overrides). The `sessionkit start` that launched the
  session opens the next one; in other sessions, a zsh hook does.
- **`sessionkit setup` adds the zsh hook** for `sessionkit next` to `~/.zshrc`, between marker
  lines; `--remove` takes it out.

### Changed

- **A message to a cold, expensive session continues in a fresh one.** The prompt hook closes
  the session and runs `sessionkit start --session <this session> "your message"` in the same
  terminal, where `sessionkit start` or the zsh hook can open it. Elsewhere it still stops the
  message once.

## [0.6.0] - 2026-09-27

### Added

- **Usage limits in the status line on a subscription.** When Claude Code sends `rate_limits`,
  the status line shows the 5-hour and 7-day limits next to the dollars, and an estimate of what
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
