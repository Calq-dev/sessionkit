# Changelog

All notable changes to sessionkit, called jev-start before 0.3.0. The format follows [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

## [0.21.0] - 2026-10-06

### Fixed

- **The cold-cache dialog always offers Compact and continue.** Since 0.20.0 a message that
  looked like new work got only Clear and continue, and the route question took most short
  follow-ups ("ja doe maar", "commit en push maar") for new work: over 59 real messages after a
  pause it offered Clear instead of Compact for 40. The question now sees the message beside the
  session's last requests and last answer: 9 of 59. Clear stays, as an extra first option.

### Changed

- **The coding agent starts the architect; sessionkit no longer does.** For a change Jev finds
  architectural, the agent that made it gets a note: the file, Jev's reading and the decision
  records it may go against. It checks a small case itself, or starts `sessionkit:architect` in
  the background without its own reasoning, and puts a broken rule or a decision to the person.
  With a model whose auto-mode classifier runs server side, such as Opus, every review the hook
  started was refused ("the request that produced this action did not ask for one"); an agent
  the model starts is reviewed as usual. The note comes once per file and reading in a session,
  with the text of each decision record it names (up to 1500 characters).
  Gone: the read-only `sessionkit:architect-review`, the review queue and the architect's
  Follow/Decide/Discuss dialog.

## [0.20.0] - 2026-10-03

### Added

- **The architect.** A repository onboarded with `/sessionkit:architecture onboard` gets an
  architect: the agent type `sessionkit:architect`, with its memory in `ARCHITECTURE.md` and
  decisions in `docs/adr/`. Onboarding surveys the repository, separates what the code shows from
  what was meant, asks about the assumptions that would mislead many later reviews, ordered by
  what the cited code shows (`sessionkit architect rank`, a citation check with Jev), and sets a
  baseline commit; debt it finds becomes known debt that is not warned about again unless a
  change widens it. Each plan and each Edit or Write then goes to Jev without waiting (`hook architect-check`): one Choice
  over what the change does to the architecture, with known debt and deliberate exceptions as
  bins of their own, and in the same request one Choice per decision record in `docs/adr/`:
  follows, goes against or unrelated. A change at 0.6 or more, or one that goes against a
  record, wakes a read-only review in the background with that record's text; its
  advice reaches the agent as one message; a decision or drift is put to you in Claude Code's
  dialog, and a decision you take is recorded when the turn ends. `/sessionkit:architecture
  audit` reports the delta since the baseline. A git repository without an architect gets one
  question per session, after the first answer: onboard now, not now, or never for this project
  (kept in `~/.config/sessionkit/architect.json`). Plugin option *Architect*: advise (default),
  shadow or off. On fifteen test cases Jev put all nine architectural changes at 0.90 or more and
  all six ordinary ones at 0.46 or less, and named the decision record a change goes against in
  12 of 13 labelled cases.

- **Cost awareness (experimental).** Plugin option *Cost awareness*, off by default: why
  tokens matter once per session and once per subagent (a limited budget per period; money,
  energy and water), the cost note only when the context has doubled, a subagent's own cost each
  time its context doubles, and what a subagent took when it ends (`hook awareness-start`,
  `hook awareness-agent`). Where the status line knows the 5-hour limit, its share stands beside
  the dollars.

### Changed

- **New work clears instead of opening a fresh session.** When a message to a cold session looks
  like new work, the dialog offers **Clear and continue**: /clear in this session, then the
  message. It no longer closes the session for a fresh one, and it works without a handoff too.
- The fold's `turn.complete` hook matches `reason: "answer"`, so another hook of the plugin can
  see every end of a turn.

## [0.19.0] - 2026-10-02

### Added

- **The large-context dialog also looks at subagents.** When a subagent of the session has
  passed the line (375K, `SESSIONKIT_COMPACT_ABOVE`) while the main session is below it and no
  auto-compact window is set, the dialog offers to set one with `/autocompact 375000`. Without a
  window a subagent never compacts; Claude Code has one window for the main session and its
  subagents. Asked once per session. On the maintainer's transcripts subagents were half of all
  cost and compacted 3 times in 618 transcripts.
- **Effort per prompt, in shadow.** About two thirds of the output of main sessions here is
  thinking, at the effort level picked once for the session. At the first model request of a
  turn you typed, Jev says which effort level is enough for the prompt, and `hook effort-route`
  logs that beside the level the turn ran at, in `~/.cache/sessionkit/effort-routes.jsonl`. It
  changes nothing. With the plugin option *Lower the effort per prompt*, off by default, the
  turn runs at Jev's level when that is lower. The prompt cache holds on Opus 5.5 and Sonnet
  5.5 (measured: the lowered turn and the one after it each read the whole context from the cache);
  it stays off until Jev's answers are measured.
- **Fold a turn when it ends (option, off by default).** When a turn ends that added 20,000
  characters of tool output or more, the output of each call that changed no file is cut to its
  first 300 characters, by a compaction the plugin starts itself (`sessionkit compact --fold`,
  without Jev). Every earlier message stays as it is, so the prompt cache holds: on a turn that
  read a file of 22K tokens, the next call read 51.6K from the cache and wrote 0.8K, where the
  context had been 74.5K. Interactive sessions only. Turn it on in `/config`.

### Fixed

- **`usage` counts the whole output of a call.** Claude Code writes a response as a line per
  block, and `usage` took the output count of the first line, which for subagents is often the
  count at the start of the stream. It now takes the highest. On the maintainer's transcripts
  output went from 31.8M to 48.6M tokens, $870 to $1,370.

### Changed

- **The robot output style refers to the person in the third person**, as "the user" in the
  language of the chat, and writes a step for the person as a statement, not a command.

## [0.18.0] - 2026-10-02

### Added

- **Weekly reset in the status line.** On a subscription the 7-day limit now shows how long
  until it resets, for example `7d 41% (reset in 3d 4h)`.

### Fixed

- **Cold cache rebuilds respect the 1-hour cache.** `usage` counted a pause of more than 5
  minutes as a rebuild, also in sessions that write a 1-hour cache. On the maintainer's
  transcripts this removed 19 of 161 rebuilds, $56 of $780.
- **Fast mode in "cheaper to restart".** The cost of one more call and of a cold resume now
  doubles for a session in fast mode, as the status line already did.
- **Claude Sonnet 5.5 has a price.** `usage` left its calls out of the costs ("no price"). The
  prices are built in, from Anthropic's model table as of 2026-09-25; neither the Claude API nor
  Claude Code publishes per-token prices in a form a program can read.
- **A number setting that is empty or no number keeps its default.** An empty
  `SESSIONKIT_BLOCK_COLD_ABOVE` or `SESSIONKIT_COMPACT_ABOVE` counted as 0, so every cold or
  warm session got the warning; a typo counted as "never". The same holds for
  `SESSIONKIT_WARN_RESUME_ABOVE` and `SESSIONKIT_CONFIRM_ABOVE`.

### Changed

- **One place for prices.** The status line, the cold-cache warning and `usage` now price
  tokens through one module, `src/pricing.rs`.

## [0.17.1] - 2026-10-02

### Changed

- **Compact later by default.** The large-context prompt now starts at 375K tokens instead of
  300K. “Always at 375K” sets Claude Code's `/autocompact 375000`. Existing explicit settings
  and `SESSIONKIT_COMPACT_ABOVE` still take precedence.

## [0.17.0] - 2026-10-02

### Added

- **Explicit key setup for Jev / TypeSafe.** `sessionkit auth login` accepts a key without
  terminal echo and stores it in the macOS Keychain; `--stdin` supports automation without
  putting secrets in process arguments. `auth status` shows only the credential source, and
  `auth logout` removes current and legacy stored keys. Login does not make an API request.

### Changed

- **No personal 1Password default.** The hardcoded vault and item have been removed. Set
  `SESSIONKIT_OP_REFERENCE=op://vault/item/field` to opt into a 1Password CLI fallback.
  `TYPESAFE_API_KEY` still takes precedence, followed by the Keychain. A refused Keychain key
  without a configured fallback now asks you to log in again instead of invoking 1Password.

### Fixed

- **`usage --tools` counts images.** It left them out; a screenshot costs up to 4,784 tokens and
  stays in the context like text. Each image now counts at the visual tokens Claude gives its
  size: one per 28x28 pixels, after the resize of the model's tier. Over 14 days here: 1,285
  images, 2.0M tokens, 6% of all tool results; Read's share of the re-read went from 16% to 21%.
  The JSON has `imageTokens` per tool.

## [0.16.1] - 2026-09-30

### Added

- **Agents see what their calls cost.** Above 50K tokens of context (`SESSIONKIT_COST_NOTE_ABOVE`),
  each message brings one line into the agent's context: its context size and cost per call, and
  those of up to three other sessions running in this folder. Facts only. The help and the skill
  now give Jev's price, about $0.0005 a file, instead of "costs money".

### Fixed

- **`setup` names everything the plugin does.** It listed three of its hooks; now one line per
  hook and the output style, and the plugin's own description says the same.

## [0.16.0] - 2026-09-30

### Added

- **An optional output style, `sessionkit-robot`.** Terse and neutral; after a tool call that
  taught it something, the agent writes one `Noted:` line with the exact facts, which a
  compaction without summary keeps. Pick it with `/output-style sessionkit-robot`; nothing
  switches it on by itself. `sessionkit trim --articulation [--days n]` measures how many of the
  facts an agent used after a possible compaction were in its own text: 7.5% over 93 sessions
  before the style, locally and free.
- **A large warm session asks to compact first.** Above 300K tokens of context
  (`SESSIONKIT_COMPACT_ABOVE`), the dialog shows what a call costs now and after /compact.
  *Compact first* runs /compact and then sends the message; *Always at 300K* also sets Claude
  Code's `/autocompact`, so it compacts by itself from then on, also in auto mode. Simulated over
  earlier sessions, compacting at 300K saved about half of the cache reads.
- **An Edit refused for an unread file is read and tried again.** Claude Code refuses an Edit of
  a file no Read in the session has seen, also when the agent read it with `cat` or `sed`, or
  before a compaction: 98 of 8,635 edits in the transcripts here, after which the agent mostly
  read the whole file again. The plugin now does that Read itself, through the engine, so the
  text stays out of the conversation, and retries the Edit, whose `old_string` must still match
  exactly once. Not for `replace_all` or Write.
- **A teammate's report that arrives twice is left out the second time.** When a teammate goes
  idle, its notification carries its report again, after it already sent it with SendMessage:
  101 of 616 such notifications in the transcripts here, and 75 of them cost the lead a turn at a
  median context of 371K tokens. The notification still arrives; its repeated result becomes one
  line that names the earlier message.
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
