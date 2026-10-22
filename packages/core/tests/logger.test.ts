import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createLogger, redactObject, redactText, defaultLogFile } from "../src/logger.js";

describe("redaction (E16)", () => {
  it("redacts sensitive keys at any nesting depth", () => {
    const input = {
      apiKey: "sk-abcdefgh12345678",
      nested: { authorization: "Bearer abcdef123456", password: "hunter2", cookie: "sid=1" },
      list: [{ token: "tok_1234567890" }],
      keep: { model: "deepseek-chat", maxSteps: 12 },
    };
    const out = redactObject(input) as Record<string, any>;

    expect(out.apiKey).toBe("***");
    expect(out.nested.authorization).toBe("***");
    expect(out.nested.password).toBe("***");
    expect(out.nested.cookie).toBe("***");
    expect(out.list[0].token).toBe("***");
    expect(out.keep).toEqual({ model: "deepseek-chat", maxSteps: 12 });
  });

  it("does not mangle token-usage counters (they are metrics, not credentials)", () => {
    const out = redactObject({ tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }) as Record<string, any>;
    expect(out.tokenUsage.promptTokens).toBe(10);
    expect(out.tokenUsage.totalTokens).toBe(15);
  });

  it("strips sk-* and Bearer fragments that appear inside free text", () => {
    const text = "request failed with sk-abcdefgh12345678 and header Bearer abc.def.ghi";
    const out = redactText(text);
    expect(out).not.toContain("sk-abcdefgh12345678");
    expect(out).not.toContain("Bearer abc.def.ghi");
    expect(out).toContain("***");
  });

  it("redacts error messages and stacks without losing the error code", () => {
    const err = Object.assign(new Error("boom key=sk-abcdefgh12345678"), { code: "PROVIDER_FAILED" });
    const out = redactObject(err) as Record<string, unknown>;
    expect(out.message).not.toContain("sk-abcdefgh");
    expect(out.code).toBe("PROVIDER_FAILED");
  });

  it("handles circular structures", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(() => redactObject(a)).not.toThrow();
    expect((redactObject(a) as Record<string, unknown>).self).toBe("[circular]");
  });
});

describe("createLogger", () => {
  it("E16 never writes a credential to the log file", () => {
    const home = mkdtempSync(path.join(tmpdir(), "agentx-log-"));
    const file = defaultLogFile(home);
    const logger = createLogger({ level: "debug", stderr: false, file });

    logger.info("provider.configured", { provider: "deepseek", apiKey: "sk-secretvalue123456" });
    logger.error("auth.failed", { headers: { authorization: "Bearer sk-secretvalue123456" } });
    logger.warn("token usage", { tokenUsage: { totalTokens: 42 } });

    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("sk-secretvalue123456");
    expect(text).toContain("provider.configured");
    expect(text).toContain('"totalTokens":42');
    // 文件是结构化 JSON 行
    for (const line of text.trim().split("\n")) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("writes nothing to stdout and respects the level threshold", () => {
    const written: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const logger = createLogger({ level: "warn", stderr: false });
      logger.debug("should be dropped");
      logger.info("should be dropped");
      logger.warn("kept");
    } finally {
      process.stdout.write = origWrite;
    }
    expect(written.join("")).toBe("");
  });

  it("derives a dated log file name", () => {
    const name = path.basename(defaultLogFile("/tmp/home", new Date(2026, 0, 5)));
    expect(name).toBe("agentx-2026-01-05.log");
  });
});
