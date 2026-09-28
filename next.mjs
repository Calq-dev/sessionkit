// sessionkit next — from inside Claude Code, close this session and start a fresh one with a
// new prompt, when the prompt cache has gone cold.
//
// Run it with Claude Code's ! prefix:  ! sessionkit next "the next prompt"
//
// A ! command runs under Claude Code without the terminal, so it cannot start a new interactive
// session itself. Something that owns the terminal must do it once Claude Code has exited. next
// leaves the prompt in a handoff file for one of two owners, and stops Claude Code:
//   - the sessionkit start that launched this Claude Code (file named after Claude Code's pid);
//   - else the zsh hook that sessionkit setup installs (file named after the terminal), which
//     runs sessionkit next --run-pending before the next shell prompt.
// Either one then runs sessionkit start --session <this session> "the next prompt".

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { cacheState } from "./cache.mjs";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const HANDOFF_DIR = join(homedir(), ".cache", "sessionkit", "next");
const HANDOFF_MAX_AGE_MS = 60 * 1000;  // an older handoff is left over from a stop that failed

const USAGE = `Usage: ! sessionkit next [options] "prompt"

Inside Claude Code: when the prompt cache of this session has gone cold, close the session and
continue in a fresh one with the prompt: sessionkit start --session <this session> "prompt".

Options:
  --force     also when the cache is still warm
  -h, --help  show this help`;

function parseArguments(argv) {
  const options = { force: false, runPending: null, prompt: "" };
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") options.force = true;
    else if (arg === "--run-pending") options.runPending = argv[++i];
    else if (arg === "-h" || arg === "--help") { console.log(USAGE); process.exit(0); }
    else words.push(arg);
  }
  options.prompt = words.join(" ").trim();
  if (!options.prompt && !options.runPending) { console.error(USAGE); process.exit(2); }
  return options;
}

function transcriptOf(session) {
  for (const folder of readdirSync(PROJECTS_DIR)) {
    const path = join(PROJECTS_DIR, folder, `${session}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
}

const psField = (field, pid) => execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8" }).trim();

/** The terminal a process runs in, as zsh's ${TTY:t} names it (ttys001), or null. */
function terminalOf(pid) {
  const name = psField("tty", pid);
  return /^ttys?\d+$/.test(name) ? name : null;
}

/** The handoff for this key, once: the file is removed, and a stale one is ignored. */
function takeHandoff(key) {
  const file = join(HANDOFF_DIR, `${key}.json`);
  if (!existsSync(file)) return null;
  try {
    const handoff = JSON.parse(readFileSync(file, "utf8"));
    return Date.now() - handoff.time < HANDOFF_MAX_AGE_MS ? handoff : null;
  } catch {
    return null;
  } finally {
    rmSync(file, { force: true });
  }
}

/** Start the session a handoff asks for: what the owner of the terminal runs. */
async function runHandoff(handoff) {
  process.stderr.write(`\nsessionkit: continuing session ${handoff.session.slice(0, 8)} in a fresh one\n`);
  const { startMain } = await import("./start.mjs");
  return startMain(["--session", handoff.session, handoff.prompt]);
}

async function nextMain(argv) {
  const options = parseArguments(argv);
  if (options.runPending) {
    const handoff = takeHandoff(options.runPending);
    return handoff ? runHandoff(handoff) : undefined;
  }

  const session = process.env.CLAUDE_CODE_SESSION_ID;
  const claudePid = Number(process.env.CLAUDE_PID);
  if (!session || !claudePid) throw new Error("run this inside Claude Code, with the ! prefix.");
  const restart = `sessionkit start --session ${session.slice(0, 8)} ${JSON.stringify(options.prompt)}`;

  const transcript = transcriptOf(session);
  const state = transcript ? cacheState(transcript) : null;
  if (state?.warm && !options.force) {
    console.log(`The cache is still warm for ${Math.ceil(state.left / 60000)} more minutes: the next message ` +
      `costs ${state.perCall === null ? "only a cache read" : `about $${state.perCall.toFixed(3)}`}. ` +
      "Send the prompt here, or add --force to start fresh anyway.");
    return;
  }

  const key = handoffKey(claudePid);
  if (!key) {
    console.log("Nothing in this terminal can open the next session after this one closes. Run " +
      "sessionkit setup once to add the zsh hook, and open a new terminal. For now, exit Claude " +
      `Code and run:\n  ${restart}`);
    return;
  }
  console.log(`Closing this session; next: ${restart}`);
  leaveHandoff(key, session, options.prompt);
  process.kill(claudePid, "SIGTERM");
}

/**
 * Who can open the next session once this Claude Code has exited: the sessionkit start that
 * launched it (key: Claude Code's pid), else the zsh hook (key: the terminal), else nobody.
 */
function handoffKey(claudePid) {
  const launcher = Number(process.env.SESSIONKIT_LAUNCHER);
  if (launcher && Number(psField("ppid", claudePid)) === launcher) return String(claudePid);
  return process.env.SESSIONKIT_SHELL ? terminalOf(claudePid) : null;
}

/** Leave the prompt for the owner of the terminal; it acts once Claude Code has exited. */
function leaveHandoff(key, session, prompt) {
  mkdirSync(HANDOFF_DIR, { recursive: true });
  writeFileSync(join(HANDOFF_DIR, `${key}.json`), JSON.stringify({ session, prompt, time: Date.now() }));
}

export { handoffKey, leaveHandoff, nextMain, runHandoff, takeHandoff };
