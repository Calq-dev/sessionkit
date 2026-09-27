# jev-start

Start a new Claude Code, Codex or jcode session with the relevant parts of earlier Claude Code
sessions.

A long session with a cold cache is expensive to resume: `claude --resume` sends the whole
conversation again. jev-start starts a fresh session instead and appends only what matters
for your first prompt. [Jev](https://docs.typesafe.ai) selects the parts. It never writes or
summarizes; everything it keeps stays verbatim.

## Install

Requires Node.js 20 or later and the agent you start: `claude`, `codex` or `jcode`. There are
no dependencies.

```sh
git clone https://github.com/Calq-dev/jev-start.git ~/Projects/jev-start
ln -s ~/Projects/jev-start/jev-start.mjs ~/.local/bin/jev-start
```

## Usage

```sh
jev-start "continue with the staag migration"          # Jev sees it continues one session
jev-start "what was decided about the upload slots?"   # Jev sees a loose question and searches
jev-start --pick "continue"                            # choose one session from a list
jev-start --session "staag emdash" "continue"          # one session, by words from its title
jev-start --session 9d17b657 "continue"                # one session, by id or id prefix
jev-start --session last "continue"                    # the newest session in this folder
jev-start --dry-run --verbose "…"                      # show the context and scores only
jev-start --agent codex --pick "continue"              # start Codex instead of Claude Code
jev-start "…" -- --permission-mode plan                # everything after -- goes to the agent
```

| Option | Meaning |
| --- | --- |
| `--agent <name>` | `claude`, `codex` or `jcode`. The default is `claude`, or `JEV_START_AGENT`. |
| `--search` | Always search. Do not let Jev decide to continue one session. |
| `--pick` | Choose a session from a list of recent sessions in every project. Sessions from this folder come first. |
| `--session <s>` | Continue one session: an id, an id prefix, `last`, or words from its title. |
| `--all` | Search the sessions of every project, not only this folder. This is the default when the folder has no sessions. |
| `--top <n>` | Keep at most n sessions when searching (default 4). |
| `--yes` | Do not ask before spending. See "What it costs". |
| `--dry-run` | Print the context and the agent command. Do not start the agent. |
| `--verbose` | Print the Jev score of every session or turn. |

The context is written to `~/.cache/jev-start/<time>.md`. Each agent gets it in its own way:

| Agent | How the context goes in |
| --- | --- |
| `claude` | `--append-system-prompt-file <context>`, then your prompt. |
| `codex` | `-c developer_instructions=<context>`, then your prompt. This replaces any `developer_instructions` in `~/.codex/config.toml` for this session. |
| `jcode` | jcode takes no first prompt. jev-start waits for the new session to appear in `~/.jcode/active_pids` and sends the first message ("read the context file, then: your prompt") to that session id with `jcode transcript -S`. The message is also on the clipboard, in case it does not arrive. |

When you continue one session, the agent starts in that session's folder. When jev-start
starts Claude Code, it notes the new session id and the sessions it came from in
`~/.cache/jev-start/chains.jsonl`. A later run then offers the newer session instead of the
older one. jev-start reads
Claude Code sessions only; Codex and jcode sessions are not searched.

## How it works

Sessions are the JSONL transcripts in `~/.claude/projects`. An exchange is a prompt you typed
plus the last text Claude wrote before your next prompt. Shell commands you ran with `!` are
not exchanges.

**Deciding** (a prompt only):

1. Jev asks one yes/no question per session: did this session work on the subject of the new
   prompt? It sees a card with the title, folder, branch, every request with the start of its
   outcome, and the final outcome. Sessions at 0.3 or higher go on.
2. Jev chooses between the five best sessions and "new topic": does the prompt continue one
   of them? At 0.7 or higher for one session, jev-start continues it. Between 0.3 and 0.7 it
   asks you. Otherwise it searches.

**Searching:** Jev asks one question per exchange in the best sessions: does this exchange
help with the new prompt? Exchanges at 0.5 or higher are kept, within about 6k tokens.

**Continuing one session** (chosen by Jev, or with `--session` or `--pick`):

1. Jev sees the whole session as an outline: every turn with its request, the start of its
   conclusion and the files it changed. The goal is your prompt plus the last three prompts
   of the session, so a vague prompt such as "continue" still works.
2. Jev asks per turn: does this still apply? A preference or rule you stated still applies
   after the work is done. A turn that a later turn replaced, or a one-off step, does not.
   It also asks per turn: does this request state a rule or preference?
3. Jev cuts every conclusion into paragraphs and list items, and asks per block: is this
   still open? Rules and open items need 0.7 or higher, because they go at the top. At most
   eight open items are shown, the strongest ones.
4. Git adds what changed since the session: the branch now, the commits after it, the
   uncommitted changes, and which files of the session changed afterwards.
5. The context starts with what changed since, your rules, and the open items. Then come the
   files the session changed, its last commands, the last compaction summary, and the turns:
   the first, the last two, and the ones that still apply. The budget is about 15k tokens.

## What it costs

Before it sends anything, jev-start runs the whole selection dry: no network, a neutral answer
to every question, and the largest sessions wherever the real run would pick by score. It
counts the characters it would send and prints an upper bound:

```text
jev-start: at most $0.04 (32 requests, at most 974,524 tokens)
jev-start: 149 sessions read, 4 relevant (209,834 Jev tokens, about $0.0088)
```

Above $0.05 it asks before it spends anything. Set the limit with `JEV_START_CONFIRM_ABOVE`,
or skip the question with `--yes`. Measured on 27 September 2026:

| Run | Estimate | Real |
| --- | --- | --- |
| Continue one session | at most $0.0017 | $0.0017 |
| Search 149 sessions, loose question | at most $0.04 | $0.0088 |
| Search 149 sessions, continuation | at most $0.04 | $0.0060 |

The estimate converts characters to tokens at 3.5 per token; a real run measured 3.76, so the
estimate stays on the high side.

## The TypeSafe key

jev-start looks for the key in this order:

1. `TYPESAFE_API_KEY` in the environment.
2. The macOS keychain, service `jev-start`.
3. 1Password (`op://Calq/TypeSafe API/credential`), once. The key then goes into the keychain,
   so 1Password does not ask again.

If TypeSafe refuses the stored key, jev-start reads it again from 1Password. To remove the
stored copy:

```sh
security delete-generic-password -s jev-start
```

## What leaves your machine

Parts of your transcripts go to TypeSafe: session cards, outlines and exchanges. The kept
exchanges also go into the context file and the new session. jev-start does not redact
anything, so a secret that is in a transcript can end up in all of these places.

## Measured

`node eval/measure.mjs` measures the selection with labels that code makes, so a run needs no
hand work. Results go to `eval/results/` (ignored by git) and hold ids and scores, not text.

**A run costs money.** It sends parts of your transcripts to TypeSafe: about $0.20 for the
default size (30 cuts, 20 routing pairs), about $0.06 for a smoke test with
`--cuts 3 --routes 2`. Like jev-start, it first estimates the cost dry and asks before it
spends. `--estimate` stops after the estimate; `--yes` skips the question.

- **Turns.** It cuts a session at turn k and uses the real next prompt. It plants five turns
  with a known label in the free places: the real turn after the prompt (applies), the first
  turn of a session in another project (does not), a stated rule, a plain task, and one
  conclusion with an open block and a done block.
- **Routing.** A later prompt of a session must route to the cut session, which sits among
  150 others. The first prompt of a session, with that session removed, must route to a new
  topic.

Run of 27 September 2026 (seed 7, 8 cuts, 24 routing items, $0.21):

| Question | Right plant above wrong one | Right plant passes | Wrong plant passes | Real items that pass |
| --- | --- | --- | --- | --- |
| Turn still applies (0.5) | 7 of 8 | 75% (median 0.73) | 0% (median 0.25) | 67% (median 0.60) |
| Rule or preference (0.7) | 8 of 8 | 100% (median 0.95) | 0% (median 0.06) | 8% |
| Block still open (0.7) | 6 of 6 | 83% | 0% | 11% |

- A prompt from another project lowers the real turn scores by 0.15 (median), so the turn
  question reads the prompt.
- "Still applies" ranks well but keeps two thirds of real turns at 0.5. The budget, which
  takes the strongest turns first, does the real selection.
- 11% of real blocks read as open: about fifteen per session, more than a reader wants. Hence
  the cap of eight.
- Routing: jev-start continued on its own four times, three times right (0.72 to 0.87) and
  once wrong (0.67). The threshold is now 0.7. Of the other later prompts, the right session
  was often not among the candidates: a mid-session prompt such as "can you also add X" does
  not name its subject. A real jev-start prompt usually does, so these items are harder than
  real use.
- First prompts routed to a new topic 9 times out of 12.

Earlier labels from shared files and shared terms were dropped: most turns change no file,
and shared terms scored at chance.

## Limits

- The measurement below is small: 8 cuts and 24 routing items from one person's sessions.
- Jev sees later turns only in short form, so an open item that a later turn finished can
  still show as open.
- Session chains only cover Claude Code sessions that jev-start started. A session you
  continued by hand, or with Codex or jcode, still competes with the session it came from.
- Jev performs best in English. Prompts and transcripts in other languages work, but have not
  been evaluated.
- `--session last` picks the newest session in the folder. If a session is running there, it
  picks that one.
- The transcript format of Claude Code is not a public contract and can change.
