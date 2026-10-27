import { describe, expect, it } from "vitest";
import { createLogger, type ToolContext } from "@agentx/core";
import { createDefaultTools } from "../src/index.js";

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    taskId: "task_write_1",
    cwd: process.cwd(),
    signal: new AbortController().signal,
    readOnly: false,
    approved: false,
    logger: createLogger({ level: "error", stderr: false }),
    env: {},
    ...over,
  };
}

describe("memory tools", () => {
  it("registers neither memory tool without hooks", () => {
    const names = createDefaultTools().map((t) => t.name);
    expect(names).not.toContain("memory_search");
    expect(names).not.toContain("memory_add");
  });

  it("registers memory_add only when the add hook is provided", () => {
    const names = createDefaultTools({ memoryAdd: async () => "ok" }).map((t) => t.name);
    expect(names).toContain("memory_add");
    expect(names).not.toContain("memory_search");
  });

  it("memory_add forwards text/source/tags and is not marked read-only", async () => {
    const calls: Array<{ text: string; source?: string; tags?: string[]; taskId?: string }> = [];
    const tool = createDefaultTools({
      memoryAdd: async (input) => {
        calls.push(input);
        return "saved memory abc12345";
      },
    }).find((t) => t.name === "memory_add");
    if (!tool) throw new Error("memory_add not registered");

    expect(tool.readOnly).toBe(false);

    const r = await tool.execute(
      { text: "prefer pnpm", source: "cli:add", tags: ["tooling"] },
      ctx({ taskId: "task_42" }),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("abc12345");
    expect(calls).toEqual([
      { text: "prefer pnpm", source: "cli:add", tags: ["tooling"], taskId: "task_42" },
    ]);
  });

  it("memory_add reports store failures instead of throwing", async () => {
    const tool = createDefaultTools({
      memoryAdd: async () => {
        throw new Error("memory entry rejected: too large");
      },
    }).find((t) => t.name === "memory_add");
    if (!tool) throw new Error("memory_add not registered");

    const r = await tool.execute({ text: "x".repeat(10) }, ctx());
    expect(r.ok).toBe(false);
    expect(`${r.error}`).toMatch(/rejected/);
  });

  it("memory_add rejects empty text at the schema level", () => {
    const tool = createDefaultTools({ memoryAdd: async () => "ok" }).find((t) => t.name === "memory_add");
    if (!tool) throw new Error("memory_add not registered");
    expect(tool.inputSchema.safeParse({ text: "" }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ text: "ok" }).success).toBe(true);
  });
});
