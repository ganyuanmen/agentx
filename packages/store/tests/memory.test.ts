import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { MarkdownMemory } from "../src/index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "agentx-mem-"));
});

describe("MarkdownMemory", () => {
  it("stores an entry with a stable id, source and timestamp, and reads it back", () => {
    const mem = new MarkdownMemory(dir);
    const entry = mem.add({ text: "the project uses pnpm workspaces", source: "user:decision" });

    expect(entry.id).toBeTypeOf("string");
    expect(entry.id.length).toBeGreaterThanOrEqual(6);
    expect(entry.source).toBe("user:decision");
    expect(entry.createdAt).toBeTypeOf("string");

    const list = mem.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.text).toContain("pnpm workspaces");
    expect(existsSync(mem.file)).toBe(true);
  });

  it("persists to a human-readable markdown file", () => {
    const mem = new MarkdownMemory(dir);
    mem.add({ text: "prefer pnpm over npm", source: "user:pref" });
    const raw = readFileSync(mem.file, "utf8");
    expect(raw).toContain("prefer pnpm over npm");
    expect(raw).toContain("user:pref");
  });

  it("searches by keyword, case-insensitively, and ranks the better match first", () => {
    const mem = new MarkdownMemory(dir);
    mem.add({ text: "deployment uses docker compose", source: "a" });
    mem.add({ text: "docker docker docker is the main runtime", source: "b" });

    const hits = mem.search("docker");
    expect(hits.length).toBe(2);
    expect(hits[0]?.source).toBe("b");

    expect(mem.search("kubernetes")).toEqual([]);
    expect(mem.search("DOCKER").length).toBe(2);
  });

  it("removes an entry by id and reports whether it existed", () => {
    const mem = new MarkdownMemory(dir);
    const e = mem.add({ text: "temporary fact", source: "s" });

    expect(mem.remove(e.id)).toBe(true);
    expect(mem.list()).toHaveLength(0);
    expect(mem.remove("nonexistent")).toBe(false);
  });

  it("refuses to store an oversized entry so task logs are not dumped into memory", () => {
    const mem = new MarkdownMemory(dir);
    expect(() => mem.add({ text: "x".repeat(5000), source: "log" })).toThrowError(/too large|4000|length/i);
    expect(mem.list()).toHaveLength(0);
  });

  it("refuses an empty entry", () => {
    const mem = new MarkdownMemory(dir);
    expect(() => mem.add({ text: "   ", source: "s" })).toThrow();
  });

  it("keeps every entry traceable to a source (no untraceable facts)", () => {
    const mem = new MarkdownMemory(dir);
    mem.add({ text: "fact one", source: "user:explicit" });
    for (const e of mem.list()) {
      expect(e.source.length).toBeGreaterThan(0);
    }
  });

  it("survives a fresh instance over the same directory", () => {
    new MarkdownMemory(dir).add({ text: "durable fact", source: "s" });
    const reopened = new MarkdownMemory(dir);
    expect(reopened.search("durable")).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
