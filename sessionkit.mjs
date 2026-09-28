#!/usr/bin/env node
// sessionkit — start, measure and analyse agent sessions.
//
//   sessionkit start    start Claude Code, Codex or jcode with what matters from earlier sessions
//   sessionkit next     inside Claude Code: close a cold session and continue in a fresh one
//   sessionkit usage    where the tokens and the money go in your Claude Code sessions
//   sessionkit measure  measure whether start selects the right context
//   sessionkit statusline, sessionkit hook   show in Claude Code what the prompt cache costs
//   sessionkit setup    put the status line and hooks in Claude Code's settings
//
// A prompt without a command means start.

const HELP = `sessionkit — start, measure and analyse agent sessions

Usage:
  sessionkit start [options] "prompt"   start an agent with what matters from earlier sessions
  ! sessionkit next "prompt"            inside Claude Code: close a cold session, continue fresh
  sessionkit usage [options]            where the tokens and the money go (local, free)
  sessionkit measure [options]          measure the selection of start (costs money)
  sessionkit statusline                 Claude Code status line: context, cost per call, cache
  sessionkit hook session-start|prompt  Claude Code hooks: warn on a costly resume or cold message
  sessionkit setup [--remove]           install the status line and hooks in Claude Code
  sessionkit "prompt"                   the same as start

Run sessionkit <command> --help for the options of a command.`;

const COMMANDS = {
  start: async (argv) => (await import("./start.mjs")).startMain(argv),
  next: async (argv) => (await import("./next.mjs")).nextMain(argv),
  usage: async (argv) => (await import("./usage.mjs")).usageMain(argv),
  measure: async (argv) => (await import("./measure.mjs")).measureMain(argv),
  statusline: async () => (await import("./claude.mjs")).statuslineMain(),
  hook: async (argv) => (await import("./claude.mjs")).hookMain(argv),
  setup: async (argv) => (await import("./setup.mjs")).setupMain(argv),
};

const [command, ...rest] = process.argv.slice(2);
if (!command || command === "help" || command === "-h" || command === "--help") {
  console.log(HELP);
  process.exit(command ? 0 : 2);
}
const run = COMMANDS[command] ? COMMANDS[command](rest) : COMMANDS.start(process.argv.slice(2));
run.catch((error) => {
  process.stderr.write(`sessionkit: ${error.message}\n`);
  process.exit(1);
});
