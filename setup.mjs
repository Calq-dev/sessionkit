// sessionkit setup — put the status line and the two hooks in Claude Code's settings, and the
// zsh hook that lets sessionkit next open the next session, in ~/.zshrc.
//
// A Claude Code plugin can ship hooks but not a status line, so this command writes both into
// ~/.claude/settings.json, with the path where sessionkit is installed on this machine. It makes
// a backup first, leaves every other setting and hook alone, and can run again safely: it
// replaces its own entries instead of adding them twice. --remove takes them out again.
//
// The zsh hook sits between two marker lines in ~/.zshrc, so setup can replace or remove it.

import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";

const USAGE = `Usage: sessionkit setup [options]

Adds the sessionkit status line and hooks to Claude Code's user settings, and on zsh the hook
that lets sessionkit next open the next session to ~/.zshrc.

Options:
  --remove           take the sessionkit status line and hooks out again
  --force            replace a status line that is not sessionkit's without asking
  --settings <file>  another settings file (default ~/.claude/settings.json)
  --zshrc <file>     another zsh startup file (default ~/.zshrc)
  --dry-run          print the result instead of writing it
  -h, --help         show this help`;

/** A command is ours when it runs sessionkit's statusline or hook subcommand. */
const OURS = /sessionkit(\.mjs)?["']?\s+(statusline|hook\s)/;
const ZSH_START = "# >>> sessionkit >>>";
const ZSH_END = "# <<< sessionkit <<<";

function parseArguments(argv) {
  const options = { remove: false, force: false, dryRun: false, settings: join(homedir(), ".claude", "settings.json"),
    zshrc: /zsh$/.test(process.env.SHELL ?? "") ? join(process.env.ZDOTDIR || homedir(), ".zshrc") : null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--remove") options.remove = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--settings") options.settings = argv[++i];
    else if (arg === "--zshrc") options.zshrc = argv[++i];
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

/**
 * Before each prompt, zsh looks for a handoff that sessionkit next left for this terminal, and
 * runs it. The file test keeps the prompt fast: node starts only when there is a handoff.
 */
function zshBlock(command) {
  return [
    ZSH_START,
    "# sessionkit next: open the next Claude Code session when this one closes",
    "export SESSIONKIT_SHELL=zsh",
    `_sessionkit_next() { [[ -f ~/.cache/sessionkit/next/\${TTY:t}.json ]] && ${command} next --run-pending \${TTY:t} }`,
    "autoload -Uz add-zsh-hook && add-zsh-hook precmd _sessionkit_next",
    ZSH_END,
  ].join("\n");
}

const withoutZshBlock = (text) =>
  text.replace(new RegExp(`\\n*${ZSH_START}[\\s\\S]*?${ZSH_END}\\n?`), "\n").replace(/^\n/, "");

function backup(file, messages) {
  const copy = `${file}.sessionkit-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(file, copy);
  messages.push(`backup: ${copy}`);
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
  const command = sessionkitCommand();

  const current = settings.statusLine?.command ?? "";
  const statusLineIsOurs = OURS.test(current);
  if (options.remove) {
    if (statusLineIsOurs) { delete next.statusLine; messages.push("removed the status line"); }
    messages.push("removed the hooks");
  } else {
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
    messages.push("hook on each message: a message to a cold, expensive session continues in a fresh one");
  }
  if (!Object.keys(next.hooks).length) delete next.hooks;

  const text = `${JSON.stringify(next, null, 2)}\n`;
  const zshrc = options.zshrc && existsSync(options.zshrc) ? readFileSync(options.zshrc, "utf8") : "";
  const nextZshrc = options.zshrc && (options.remove
    ? withoutZshBlock(zshrc)
    : `${withoutZshBlock(zshrc).replace(/\n*$/, "\n\n")}${zshBlock(command)}\n`.replace(/^\n+/, ""));
  if (options.dryRun) {
    console.log(text);
    if (nextZshrc !== null && options.zshrc) console.log(`${options.zshrc}:\n${nextZshrc}`);
    return;
  }
  if (existsSync(options.settings)) backup(options.settings, messages);
  else mkdirSync(dirname(options.settings), { recursive: true });
  writeFileSync(options.settings, text);
  console.log(`sessionkit setup: ${options.settings}\n${messages.map((line) => `  - ${line}`).join("\n")}\n` +
    "New Claude Code sessions pick this up; in a running session, open /hooks once.");

  const zshMessages = [];
  if (!options.zshrc) {
    console.log("No zsh: sessionkit next opens the next session only in sessions that sessionkit start launched.");
  } else if (nextZshrc !== zshrc) {
    if (zshrc) backup(options.zshrc, zshMessages);
    writeFileSync(options.zshrc, nextZshrc);
    zshMessages.push(options.remove ? "removed the zsh hook"
      : "zsh hook: sessionkit next opens the next session in this terminal");
    console.log(`sessionkit setup: ${options.zshrc}\n${zshMessages.map((line) => `  - ${line}`).join("\n")}\n` +
      (options.remove ? "" : "New terminals pick this up; in an open terminal, run: source ~/.zshrc"));
  }
}

export { setupMain };
