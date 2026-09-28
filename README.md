# sessionkit

Start, measure and analyse your agent sessions.

- **`sessionkit start`** starts Claude Code, Codex or jcode with the relevant parts of earlier
  Claude Code sessions. A long session with a cold cache is expensive to resume, and every
  further call re-reads its whole context. `start` begins fresh and hands over only what
  matters for your first prompt. [Jev](https://docs.typesafe.ai) (TypeSafe) selects the parts;
  it never writes or summarizes, so everything kept stays verbatim.
- **`sessionkit usage`** shows where the tokens and the money go: by kind of token, by model,
  main sessions against subagents, by project, the largest sessions, cold cache rebuilds, and
  sessions that are cheaper to restart than to continue. Local and free.
- **`sessionkit measure`** measures whether `start` selects the right context.
- **`sessionkit statusline`** and **`sessionkit hook`** show inside Claude Code what the prompt
  cache costs: the context, the cost of each call, how long the cache stays warm, and a warning
  before a cold call rewrites a large context. **`sessionkit next`** closes a cold session from
  inside Claude Code and continues it in a fresh one.

## Install

Requires Node.js 20 or later, access to the Calq-dev GitHub organisation, and for `start` the
agent you start: `claude`, `codex` or `jcode`. There are no dependencies.

```sh
npm install -g github:Calq-dev/sessionkit   # the sessionkit command; run again to update
sessionkit setup                            # the status line and hooks in Claude Code
```

`start` and `measure` also need the TypeSafe key: they read it from 1Password
(`op://Calq/TypeSafe API/credential`) once and keep it in the keychain. `usage`, the status
line and the hooks need no key and no network.

## sessionkit usage

```sh
sessionkit usage                     # everything
sessionkit usage --days 7            # the last week
sessionkit usage --project lankquote # one project
sessionkit usage --json              # the numbers as JSON
```

It reads the transcripts under `~/.claude/projects`, main sessions and the subagents stored
beside them, and adds up the usage every API call records: uncached input, cache reads, cache
writes (5 minutes and 1 hour) and output. A response written as several lines, or a call a
forked session copied, is counted once.

Costs are API-equivalent: token counts times the published per-token prices, including the
lower cache-read prices of Claude Opus 5.5 and Claude Fable 5.1 and double prices for fast
mode. With a subscription you pay a flat fee instead, so read them as the value of what you
used. A model without a known price is named, and its tokens are left out of the costs.

Claude Code's own `cost-state` per session is not used. It counts per process, so a resumed
session starts again at zero; compared with the transcripts it came out both too low and too
high.

**Cold cache rebuilds** are a heuristic: a call after a pause of more than 5 minutes that
writes at least 20k tokens to the cache and reads less than it writes.

**Cheaper to restart** lists sessions active in the last 14 days whose last context is above
150k tokens. Per session it shows what one more call costs in cache reads now, the same after
a fresh start of about 15k tokens, and the one-time write of a cold `--resume`, with the
`sessionkit start` command to restart it.

## In Claude Code: status line and hooks

Claude Code does not show that a session with 800k tokens of context re-reads all of them on
every call, or that the first message after an idle hour writes them all to the cache again.

With an API key it shows dollars:

```text
context 475K · $0.095/call · cache warm 40m (cold: $3.80)
context 705K · cache cold: next message ≈ $5.64 · cheaper: sessionkit start --session 9d17b657
```

On a Pro or Max subscription a call costs a share of your usage limits, so it shows those as
well, next to the API value of the tokens:

```text
context 475K · $0.095/call · 5h 23% (reset 14:10) · 7d 41% · ≈ +0.6%/call · cache warm 40m (cold: $3.80)
```

The limits come from Claude Code itself (`rate_limits`). **What one call takes** is an estimate
that sessionkit learns on your machine, because Anthropic does not publish how tokens map to
the limits. After every call it notes how much the 5-hour limit rose and how large the context
was; the estimate is the total rise divided by the total context over your last 100 warm calls,
times the current context. It appears after 5 calls. Other sessions running at the same time
raise the limit too, so the estimate tends to be high; calls that rewrote a cold cache are kept
apart.

- **Status line.** It uses what Claude Code hands it (`prompt_cache`, `context_window`,
  `rate_limits`) and the end of the transcript before the first response. It turns yellow in the last 10 minutes of
  the cache and red when the cache has expired. With `refreshInterval` it counts down.
- **On `--resume` or fork** (`hook session-start`): when the cache has expired and writing it
  again costs more than $1, it says so before the first message, with Claude Code's own
  estimate (`estimated_cache_write_usd`).
- **Before a message to a cold session** (`hook prompt`): when writing the context again costs
  more than $2, the message does not go out. A warning would come too late, because the call
  would already run. Where it can (see below), the hook closes the session and continues your
  message in a fresh one: `sessionkit start --session <this session> "your message"`. Elsewhere
  it stops the message once and says what it would cost; send it again to go ahead.

### Continue in a fresh session from inside Claude Code

When a message goes to a cold, expensive session, the prompt hook closes it and continues the
message in a fresh session, in the same terminal. You can also do this yourself, for instance
on a warm session, with `sessionkit next` and Claude Code's `!` prefix:

```text
! sessionkit next "go on with the staging migration"
```

`next` closes this session and continues it in a fresh one:
`sessionkit start --session <this session> "go on with the staging migration"`, in the same
terminal. While the cache is still warm it refuses, because the next message there is cheap;
add `--force` to start fresh anyway.

A hook or a `!` command runs without the terminal, so it cannot open a new interactive session
itself. Something that owns the terminal must do it once Claude Code has exited. The hook and
`next` leave the prompt in `~/.cache/sessionkit/next/` and stop Claude Code. Then one of two
owners opens the next session:

- the `sessionkit start` that launched this Claude Code;
- else, in zsh, a hook that `sessionkit setup` adds to `~/.zshrc`. Before the next shell prompt
  it finds the prompt for this terminal. It only tests for a file, so your prompt stays fast.

Without either, the hook stops the message once, and `next` prints the command to run.

Nothing here reaches Claude's context: the status line, `systemMessage` and the block `reason`
are shown to you only, so the checks cost no tokens.

`sessionkit setup` writes the status line and the hooks into `~/.claude/settings.json`, with the path where
sessionkit is installed on your machine. A Claude Code plugin can ship hooks but not a status
line, which is why this is a command and not a plugin. It makes a backup first, leaves your
other settings and hooks alone, and can run again safely. It asks before it replaces a status
line that is not sessionkit's (`--force` skips the question). In zsh it also adds the hook for
`sessionkit next` to `~/.zshrc`, between two marker lines. `sessionkit setup --remove` takes
everything out again.

Set the limits with `SESSIONKIT_WARN_RESUME_ABOVE` (default 1) and `SESSIONKIT_BLOCK_COLD_ABOVE`
(default 2). Set the second very high to only warn in the status line.

## sessionkit start

```sh
sessionkit "continue with the staag migration"          # Jev sees it continues one session
sessionkit "what was decided about the upload slots?"   # Jev sees a loose question and searches
sessionkit start --pick "continue"                      # choose one session from a list
sessionkit start --session "staag emdash" "continue"    # one session, by words from its title
sessionkit start --session 9d17b657 "continue"          # one session, by id or id prefix
sessionkit start --session last "continue"              # the newest session in this folder
sessionkit start --dry-run --verbose "…"                # show the context and scores only
sessionkit start --agent codex --pick "continue"        # start Codex instead of Claude Code
sessionkit start "…" -- --permission-mode plan          # everything after -- goes to the agent
```

A prompt without a command means `start`.

| Option | Meaning |
| --- | --- |
| `--agent <name>` | `claude`, `codex` or `jcode`. The default is `claude`, or `SESSIONKIT_AGENT`. |
| `--search` | Always search. Do not let Jev decide to continue one session. |
| `--pick` | Choose a session from a list of recent sessions in every project. Sessions from this folder come first. |
| `--session <s>` | Continue one session: an id, an id prefix, `last`, or words from its title. |
| `--all` | Search the sessions of every project, not only this folder. This is the default when the folder has no sessions. |
| `--top <n>` | Keep at most n sessions when searching (default 4). |
| `--yes` | Do not ask before spending. See "What start costs". |
| `--dry-run` | Print the context and the agent command. Do not start the agent. |
| `--verbose` | Print the Jev score of every session or turn. |

The context is written to `~/.cache/sessionkit/<time>.md`. Each agent gets it in its own way:

| Agent | How the context goes in |
| --- | --- |
| `claude` | `--append-system-prompt-file <context>`, then your prompt. |
| `codex` | `-c developer_instructions=<context>`, then your prompt. This replaces any `developer_instructions` in `~/.codex/config.toml` for this session. |
| `jcode` | jcode takes no first prompt. sessionkit waits for the new session to appear in `~/.jcode/active_pids` and sends the first message ("read the context file, then: your prompt") to that session id with `jcode transcript -S`. The message is also on the clipboard, in case it does not arrive. |

When you continue one session, the agent starts in that session's folder. When sessionkit
starts Claude Code, it notes the new session id and the sessions it came from in
`~/.cache/sessionkit/chains.jsonl`. A later run then offers the newer session instead of the
older one. sessionkit reads Claude Code sessions only; Codex and jcode sessions are not
searched.

### How start selects

Sessions are the JSONL transcripts in `~/.claude/projects`. An exchange is a prompt you typed
plus the last text Claude wrote before your next prompt. Shell commands you ran with `!` are
not exchanges.

**Deciding** (a prompt only):

1. Jev asks one yes/no question per session: did this session work on the subject of the new
   prompt? It sees a card with the title, folder, branch, every request with the start of its
   outcome, and the final outcome. Sessions at 0.3 or higher go on.
2. Jev chooses between the five best sessions and "new topic": does the prompt continue one
   of them? At 0.7 or higher for one session, sessionkit continues it. Between 0.3 and 0.7 it
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

### What start costs

Before it sends anything, `start` runs the whole selection dry: no network, a neutral answer
to every question, and the largest sessions wherever the real run would pick by score. It
counts the characters it would send and prints an upper bound:

```text
sessionkit: at most $0.04 (32 requests, at most 974,524 tokens)
sessionkit: 149 sessions read, 4 relevant (209,834 Jev tokens, about $0.0088)
```

Above $0.05 it asks before it spends anything. Set the limit with `SESSIONKIT_CONFIRM_ABOVE`,
or skip the question with `--yes`. Measured on 27 September 2026:

| Run | Estimate | Real |
| --- | --- | --- |
| Continue one session | at most $0.0017 | $0.0017 |
| Search 149 sessions, loose question | at most $0.04 | $0.0088 |
| Search 149 sessions, continuation | at most $0.04 | $0.0060 |

The estimate converts characters to tokens at 3.5 per token; a real run measured 3.76, so the
estimate stays on the high side.

### The TypeSafe key

`start` and `measure` look for the key in this order:

1. `TYPESAFE_API_KEY` in the environment.
2. The macOS keychain, service `sessionkit` (or `jev-start`, the name before the rename).
3. 1Password (`op://Calq/TypeSafe API/credential`), once. The key then goes into the keychain,
   so 1Password does not ask again.

If TypeSafe refuses the stored key, sessionkit reads it again from 1Password. To remove the
stored copy:

```sh
security delete-generic-password -s sessionkit
```

### What leaves your machine

`usage` sends nothing. `start` and `measure` send parts of your transcripts to TypeSafe:
session cards, outlines and exchanges. The kept exchanges also go into the context file and
the new session. sessionkit does not redact anything, so a secret that is in a transcript can
end up in all of these places.

## sessionkit measure

`measure` checks the selection of `start` with labels that code makes, so a run needs no hand
work. Results go to `eval/results/` (ignored by git) and hold ids and scores, not text.

**A run costs money.** It sends parts of your transcripts to TypeSafe: about $0.20 for the
default size (30 cuts, 20 routing pairs), about $0.06 for a smoke test with
`--cuts 3 --routes 2`. It first estimates the cost dry and asks before it spends. `--estimate`
stops after the estimate; `--yes` skips the question.

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
- Routing: `start` continued on its own four times, three times right (0.72 to 0.87) and once
  wrong (0.67). The threshold is now 0.7. Of the other later prompts, the right session was
  often not among the candidates: a mid-session prompt such as "can you also add X" does not
  name its subject. A real prompt usually does, so these items are harder than real use.
- First prompts routed to a new topic 9 times out of 12.

Earlier labels from shared files and shared terms were dropped: most turns change no file,
and shared terms scored at chance.

## Limits

- The measurement above is small: 8 cuts and 24 routing items from one person's sessions.
- Jev sees later turns only in short form, so an open item that a later turn finished can
  still show as open.
- Session chains only cover Claude Code sessions that sessionkit started. A session you
  continued by hand, or with Codex or jcode, still competes with the session it came from.
- Jev performs best in English. Prompts and transcripts in other languages work, but have not
  been evaluated.
- `--session last` picks the newest session in the folder. If a session is running there, it
  picks that one.
- The cold-cache count in `usage` is a heuristic; a changed prompt prefix also rewrites the
  cache without a pause.
- The transcript format of Claude Code is not a public contract and can change.

## Environment

| Variable | Meaning |
| --- | --- |
| `TYPESAFE_API_KEY` | The TypeSafe key, before the keychain and 1Password. |
| `SESSIONKIT_AGENT` | The default agent for `start`. |
| `SESSIONKIT_CONFIRM_ABOVE` | Ask before spending more than this many dollars (default 0.05). |
| `SESSIONKIT_MODEL` | The Jev model (default `jev-latest`). |
| `SESSIONKIT_WARN_RESUME_ABOVE` | Warn on a resume whose cache write costs more than this (default 1). |
| `SESSIONKIT_BLOCK_COLD_ABOVE` | Stop a message to a cold session once above this cost (default 2). |

The `JEV_START_*` names from before the rename still work.
