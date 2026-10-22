import { describe, expect, it } from "vitest";
import { rewriteAgentShorthand } from "../src/main.js";

const KNOWN = ["run", "chat", "sessions", "skills", "tools", "config", "models", "doctor", "agent", "help"];

describe("rewriteAgentShorthand (agentx <name> chat)", () => {
  it("rewrites the documented shorthand into the canonical form", () => {
    expect(rewriteAgentShorthand(["reviewer", "chat"], KNOWN)).toEqual(["agent", "chat", "reviewer"]);
    expect(rewriteAgentShorthand(["reviewer", "run", "fix it"], KNOWN)).toEqual([
      "agent",
      "run",
      "reviewer",
      "fix it",
    ]);
  });

  it("carries options through untouched", () => {
    expect(rewriteAgentShorthand(["reviewer", "chat", "--model", "mock:mock-1"], KNOWN)).toEqual([
      "agent",
      "chat",
      "reviewer",
      "--model",
      "mock:mock-1",
    ]);
  });

  it("putting options before the agent name also works", () => {
    // `agentx --json reviewer chat` 实际到这里的 argv 是 ["--json", ...]，
    // 以 - 开头所以原样放行，交给 commander 的全局选项处理。
    expect(rewriteAgentShorthand(["--json", "reviewer", "chat"], KNOWN)).toEqual(["--json", "reviewer", "chat"]);
  });

  it("never rewrites a known top-level command", () => {
    for (const cmd of KNOWN) {
      const argv = [cmd, "chat"];
      expect(rewriteAgentShorthand(argv, KNOWN)).toEqual(argv);
    }
  });

  it("leaves global flags alone", () => {
    for (const flag of ["--version", "-h", "--help", "--json", "--verbose"]) {
      const argv = [flag];
      expect(rewriteAgentShorthand(argv, KNOWN)).toEqual(argv);
    }
  });

  it("does not rewrite an invalid agent name", () => {
    // 这些如果被重写，就会把路径穿越的意图送进 agent 解析层
    for (const bad of ["../etc", "a/b", "a\\b", ".", "..", ".hidden"]) {
      const argv = [bad, "chat"];
      expect(rewriteAgentShorthand(argv, KNOWN)).toEqual(argv);
    }
  });

  it("does not rewrite when there is no chat/run sub-command", () => {
    expect(rewriteAgentShorthand(["reviewer"], KNOWN)).toEqual(["reviewer"]);
    expect(rewriteAgentShorthand(["reviewer", "list"], KNOWN)).toEqual(["reviewer", "list"]);
    expect(rewriteAgentShorthand(["reviewer", "--help"], KNOWN)).toEqual(["reviewer", "--help"]);
    expect(rewriteAgentShorthand([], KNOWN)).toEqual([]);
  });

  it("is idempotent on already-canonical input", () => {
    const canonical = ["agent", "chat", "reviewer"];
    expect(rewriteAgentShorthand(canonical, KNOWN)).toEqual(canonical);
  });

  it("keeps `--` separator and everything after it", () => {
    expect(rewriteAgentShorthand(["reviewer", "run", "--", "--not-an-option"], KNOWN)).toEqual([
      "agent",
      "run",
      "reviewer",
      "--",
      "--not-an-option",
    ]);
  });
});
