// sessionkit setup — put the status line and the two hooks in Claude Code's settings.
//
// A Claude Code plugin can ship hooks but not a status line, so this command writes both into
// ~/.claude/settings.json, with the path where sessionkit is installed on this machine. It makes
// a backup first, leaves every other setting and hook alone, and can run again safely: it
// replaces its own entries instead of adding them twice. --remove takes them out again.

import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";

const USAGE = `Usage: sessionkit setup [options]

Adds the sessionkit status line and hooks to Claude Code's user settings.

Options:
  --remove           take the sessionkit status line and hooks out again
  --force            replace a status line that is not sessionkit's without asking
  --settings <file>  another settings file (default ~/.claude/settings.json)
  --dry-run          print the result instead of writing it
  -h, --help         show this help`;

/** A command is ours when it runs sessionkit's statusline or hook subcommand. */
const OURS = /sessionkit(\.mjs)?["']?\s+(statusline|hook\s)/;

function parseArguments(argv) {
  const options = { remove: false, force: false, dryRun: false, settings: join(homedir(), ".claude", "settings.json") };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--remove") options.remove = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--settings") options.settings = argv[++i];
    else if (arg === "-h" || arg === "--help") { console.log(USAGE); process.exit(0); }
    else { console.error(`sessionkit setup: unknown option ${arg}\n\n${USAGE}`); process.exit(2); }
  }
  return options;
}

/**
 * How Claude Code should call sessionkit: through the command it was started as when that is
 * the installed "sessionkit" link, which survives an update; else the script itself.
 */
function sessionkitCommand() {
  const invoked = process.argv[1];
  const path = basename(invoked) === "sessionkit" ? invoked : realpathSync(invoked);
  return /\s/.test(path) ? `"${path}"` : path;
}

/** Remove sessionkit's hook entries; drop matcher groups and events that end up empty. */
function withoutOurHooks(hooks = {}) {
  const result = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = groups
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !OURS.test(hook.command ?? "")) }))
      .filter((group) => group.hooks.length > 0);
    if (kept.length) result[event] = kept;
  }
  return result;
}

async function ask(question) {
  if (!process.stdin.isTTY) return false;
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((resolve) => readline.question(question, resolve));
  readline.close();
  return /^y/i.test(answer.trim());
}

async function setupMain(argv) {
  const options = parseArguments(argv);
  const settings = existsSync(options.settings) ? JSON.parse(readFileSync(options.settings, "utf8")) : {};
  const next = { ...settings, hooks: withoutOurHooks(settings.hooks) };
  const messages = [];

  const current = settings.statusLine?.command ?? "";
  const statusLineIsOurs = OURS.test(current);
  if (options.remove) {
    if (statusLineIsOurs) { delete next.statusLine; messages.push("removed the status line"); }
    messages.push("removed the hooks");
  } else {
    const command = sessionkitCommand();
    const replace = !settings.statusLine || statusLineIsOurs || options.force
      || await ask(`There is a status line already:\n  ${current}\nReplace it with sessionkit's? [y/N] `);
    if (replace) {
      next.statusLine = { type: "command", command: `${command} statusline`, refreshInterval: 60 };
      messages.push("status line: context, cost per call and cache time");
    } else {
      messages.push("kept the existing status line (run with --force to replace it)");
    }
    next.hooks.SessionStart = [...(next.hooks.SessionStart ?? []),
      { matcher: "resume|fork", hooks: [{ type: "command", command: `${command} hook session-start` }] }];
    next.hooks.UserPromptSubmit = [...(next.hooks.UserPromptSubmit ?? []),
      { hooks: [{ type: "command", command: `${command} hook prompt`, timeout: 10 }] }];
    messages.push("hook on --resume: warns when the expired cache is expensive to write again");
    messages.push("hook on each message: stops a message to a cold, expensive session once");
  }
  if (!Object.keys(next.hooks).length) delete next.hooks;

  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (options.dryRun) { console.log(text); return; }
  if (existsSync(options.settings)) {
    const backup = `${options.settings}.sessionkit-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(options.settings, backup);
    messages.push(`backup: ${backup}`);
  } else {
    mkdirSync(dirname(options.settings), { recursive: true });
  }
  writeFileSync(options.settings, text);
  console.log(`sessionkit setup: ${options.settings}\n${messages.map((line) => `  - ${line}`).join("\n")}\n` +
    "New Claude Code sessions pick this up; in a running session, open /hooks once.");
}

export { setupMain };
