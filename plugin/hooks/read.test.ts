// The tip after a large read, against the engine; the Read tool is stood in for beneath.
import { expect, test } from "claude-code/testing";

function world(on, lines) {
  on("session.id", () => ({ value: "session-1" }));
  on("session.cwd", () => ({ value: "/repo" }));
  on("tool.call", { tool: "Read" }, (_$, e) => {
    const content = "x\n".repeat(lines);
    return { result: { type: "text", file: { filePath: e.file_path, content, numLines: lines, startLine: 1, totalLines: lines } } };
  });
}

const tips = (result) => (result.context ?? []).filter((text) => text.startsWith("sessionkit:"));

test("a large whole-file read gets the tip once", async ($, on) => {
  world(on, 1748);
  const first = await $.tool.call({ tool: "Read", file_path: "/repo/src/start.rs" });
  expect(tips(first).length).toBe(1);
  expect(tips(first)[0]).toContain("sessionkit ask src/start.rs");
  const second = await $.tool.call({ tool: "Read", file_path: "/repo/src/next.rs" });
  expect(tips(second)).toEqual([]);
});

test("a small file gets no tip", async ($, on) => {
  world(on, 120);
  expect(tips(await $.tool.call({ tool: "Read", file_path: "/repo/a.rs" }))).toEqual([]);
});

test("a read of a range gets no tip", async ($, on) => {
  world(on, 1748);
  expect(tips(await $.tool.call({ tool: "Read", file_path: "/repo/a.rs", offset: 300, limit: 50 }))).toEqual([]);
});

test("a subagent gets its own tip", async ($, on) => {
  world(on, 1748);
  await $.tool.call({ tool: "Read", file_path: "/repo/a.rs" });
  const sub = await $.tool.call({ tool: "Read", file_path: "/repo/a.rs", agentId: "agent-1" });
  expect(tips(sub).length).toBe(1);
});
