# jev-start

Start a new Claude Code session with the relevant parts of earlier sessions.

A long session with a cold cache is expensive to resume: `claude --resume` sends the whole
conversation again. jev-start starts a fresh session instead and appends only what matters
for your first prompt. [Jev](https://docs.typesafe.ai) selects the parts. It never writes or
summarizes; everything it keeps stays verbatim.

## Install

Requires Node.js 20 or later and the `claude` CLI. There are no dependencies.

```sh
git clone https://github.com/Calq-dev/jev-start.git ~/Projects/jev-start
ln -s ~/Projects/jev-start/jev-start.mjs ~/.local/bin/jev-start
```

## Usage

```sh
jev-start "what was decided about the upload slots?"   # find relevant sessions yourself
jev-start --pick "continue"                            # choose one session from a list
jev-start --session "staag emdash" "continue"          # one session, by words from its title
jev-start --session 9d17b657 "continue"                # one session, by id or id prefix
jev-start --session last "continue"                    # the newest session in this folder
jev-start --dry-run --verbose "…"                      # show the context and scores only
jev-start "…" -- --permission-mode plan                # everything after -- goes to claude
```

| Option | Meaning |
| --- | --- |
| `--pick` | Choose a session from a list of recent sessions in every project. Sessions from this folder come first. |
| `--session <s>` | Continue one session: an id, an id prefix, `last`, or words from its title. |
| `--all` | Search the sessions of every project, not only this folder. |
| `--top <n>` | Keep at most n sessions when searching (default 4). |
| `--dry-run` | Print the context and the `claude` command. Do not start `claude`. |
| `--verbose` | Print the Jev score of every session or turn. |

The context is written to `~/.cache/jev-start/<time>.md` and passed with
`--append-system-prompt-file`. When you continue one session, `claude` starts in that
session's folder.

## How it works

Sessions are the JSONL transcripts in `~/.claude/projects`. An exchange is a prompt you typed
plus the last text Claude wrote before your next prompt. Shell commands you ran with `!` are
not exchanges.

**Searching** (a prompt only):

1. Jev asks one yes/no question per session: did this session work on the subject of the new
   prompt? It sees a card with the title, folder, branch, every request with the start of its
   outcome, and the final outcome. Sessions at 0.3 or higher go on.
2. Jev asks one question per exchange in those sessions: does this exchange help with the new
   prompt? Exchanges at 0.5 or higher are kept, within about 6k tokens.

**Continuing one session** (`--session` or `--pick`):

1. Jev sees the whole session as an outline: every turn with its request, the start of its
   conclusion and the files it changed. The goal is your prompt plus the last three prompts
   of the session, so a vague prompt such as "continue" still works.
2. Jev asks per turn: does this still apply? A preference or rule you stated still applies
   after the work is done. A turn that a later turn replaced, or a one-off step, does not.
3. The context holds the last compaction summary, the first turn, the last two turns, the
   turns Jev kept, the files the session changed, and the last commands it ran. The budget is
   about 15k tokens.

A search over 150 sessions costs about $0.02 at Jev's price. Continuing one session costs
less than a tenth of a cent.

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

- The thresholds (0.3 and 0.5) were checked on a few sessions, not on a labelled set.
- Jev performs best in English. Prompts and transcripts in other languages work, but have not
  been evaluated.
- `--session last` picks the newest session in the folder. If a session is running there, it
  picks that one.
- The transcript format of Claude Code is not a public contract and can change.
