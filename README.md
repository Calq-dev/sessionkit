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
| `--dry-run` | Print the context and the agent command. Do not start the agent. |
| `--verbose` | Print the Jev score of every session or turn. |

The context is written to `~/.cache/jev-start/<time>.md`. Each agent gets it in its own way:

| Agent | How the context goes in |
| --- | --- |
| `claude` | `--append-system-prompt-file <context>`, then your prompt. |
| `codex` | `-c developer_instructions=<context>`, then your prompt. This replaces any `developer_instructions` in `~/.codex/config.toml` for this session. |
| `jcode` | jcode takes no first prompt. jev-start waits for the new session to appear in `~/.jcode/active_pids` and sends the first message ("read the context file, then: your prompt") to that session id with `jcode transcript -S`. The message is also on the clipboard, in case it does not arrive. |

When you continue one session, the agent starts in that session's folder. jev-start reads
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
   of them? At 0.6 or higher for one session, jev-start continues it. Between 0.3 and 0.6 it
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
   still open? Rules and open items need 0.7 or higher, because they go at the top.
4. Git adds what changed since the session: the branch now, the commits after it, the
   uncommitted changes, and which files of the session changed afterwards.
5. The context starts with what changed since, your rules, and the open items. Then come the
   files the session changed, its last commands, the last compaction summary, and the turns:
   the first, the last two, and the ones that still apply. The budget is about 15k tokens.

A search over 150 sessions costs about $0.01 to $0.02 at Jev's price. Continuing one session
costs a few tenths of a cent.

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

## Limits

- The thresholds (0.3, 0.5, 0.6 and 0.7) were checked on a few sessions, not on a labelled set.
- Jev sees later turns only in short form, so an open item that a later turn finished can
  still show as open.
- When you continued a session with jev-start, the old and the new session both match. Jev
  then often doubts between them and asks you.
- Jev performs best in English. Prompts and transcripts in other languages work, but have not
  been evaluated.
- `--session last` picks the newest session in the folder. If a session is running there, it
  picks that one.
- The transcript format of Claude Code is not a public contract and can change.
