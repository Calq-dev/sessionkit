// sessionkit's tip after a large read: agents read a whole file for one fact out of habit, and
// the text stays in the context for every later turn. After the first such read in a loop (the
// main one, or a subagent's), one line tells the agent that sessionkit ask answers a question
// about a file without reading it. The read itself goes ahead unchanged.

const MIN_LINES = 400; // below this a read is cheap enough
const CHARS_PER_TOKEN = 4;

const hinted = new Set(); // loops that had the tip: once is enough to teach it

/** @type {import('claude-code').Register} */
export const register = (on) => {
  on("tool.call", { tool: "Read" }, async ($, event, next) => {
    const result = await next(event);
    if ("deny" in result || result.isError || result.result?.type !== "text") return result;
    const file = result.result.file;
    if (event.offset !== undefined || event.limit !== undefined || file.startLine > 1 || file.numLines < MIN_LINES) return result;
    const loop = `${await $.session.id()}:${event.agentId ?? "main"}`;
    if (hinted.has(loop)) return result;
    hinted.add(loop);
    const cwd = await $.session.cwd();
    const path = file.filePath.startsWith(cwd + "/") ? file.filePath.slice(cwd.length + 1) : file.filePath;
    const tokens = Math.round(file.content.length / CHARS_PER_TOKEN / 1000);
    const tip =
      `sessionkit: this read put ${file.numLines} lines (about ${tokens}k tokens) in the context, where they stay for every later turn. ` +
      `When you need a fact about a large file rather than its text, ask instead: sessionkit ask ${path} "Does it retry a failed upload?" ` +
      `answers yes or no, and sessionkit ask --find ${path} "Where is the timeout set?" names the line, so you can Read only that part ` +
      `with offset and limit. To find where a behavior lives in the repository: sessionkit grep "question". ` +
      `Read the whole file when you are going to edit much of it.`;
    return { ...result, context: [...(result.context ?? []), tip] };
  });
};
