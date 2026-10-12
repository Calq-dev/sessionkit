# Subagent cache analysis

`sessionkit usage` now reports each subagent transcript separately, alongside the
existing main-session analysis. `sessionkit usage --json` adds a `subagents` list
with agent id, parent session, usage totals, 5-minute/1-hour cache-write tokens,
suspected rebuilds (gap, written tokens, API-equivalent cost) and a
`longerTtlCandidate` hint. Existing top-level rebuild totals remain **main-session
only**, so this addition does not silently change their meaning.

A suspected rebuild is a call after a gap longer than the observed write TTL,
writing at least 20,000 cache tokens and more than it reads. Each agent has its
own timeline: interleaved calls from other agents do not keep its cache warm in
this analysis. A larger 1h write than 5m write on the rebuilding call selects the
1h lifetime; otherwise the heuristic uses 5m. Mixed-TTL prompts cannot be reduced
to a single exact expiry, and writes alone do not prove expiry rather than a
changed prefix. The first call in the selected reporting window has no preceding
gap; initial writes are not counted as rebuilds.

Two or more suspected rebuilds after 5–60-minute gaps, with predominantly 5m
writes, produce advice to consider a longer TTL **if supported**. This is not an
automatic settings change or a promised saving. One-hour writes cost more;
measure the workload before and after. No keep-alive polling is added.

## Claude Code settings: what was verified locally

The installed Claude Code changelog at `~/.claude/cache/changelog.md`, section
**2.1.243**, names `promptCacheTtl` and `subagentPromptCacheTtl`. Its description
specifically refers to API-key and cloud-provider users. The local CLI version
at investigation time was 2.1.296.

This confirms a documented setting name, **not** that a subscription user can
force 1h caching with it. The accepted values, provider-specific behavior and the
claimed `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` environment override have not been
live-verified here. SessionKit therefore does not write these settings or present
a subscription-specific one-liner as a verified fix.

All reported dollar costs are API-equivalent estimates. Claude subscription
quota accounting is not inferred from those prices. A task with frequent prefix
changes may still rewrite context even if a longer TTL is enabled.
