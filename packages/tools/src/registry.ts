import { z, type ZodTypeAny } from "zod";
import type { AgentTool, ToolSpec } from "@agentx/core";
import {
  applyPatchTool,
  listFilesTool,
  readFileTool,
  searchTextTool,
  writeFileTool,
} from "./files.js";
import { createExecTool, DEFAULT_EXEC_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES } from "./exec.js";

/** 精简的 JSON Schema 类型（工具参数只需要 object/array/基本类型）。 */
export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  additionalProperties?: boolean;
}

/**
 * Zod -> JSON Schema 转换。
 *
 * 优先使用 zod 自带的 `z.toJSONSchema`（zod >= 3.25 提供）；否则回退到本地最小转换器。
 * 本地转换器只覆盖工具实际用到的 Zod 类型：
 *  object / string / number(int) / boolean / array / optional / enum / literal。
 * 不处理的类型会退化为 `{}`（表示任意值），不会抛错。
 */
export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  const native = (z as unknown as { toJSONSchema?: (s: unknown, o?: unknown) => unknown }).toJSONSchema;
  if (typeof native === "function") {
    try {
      const out = native(schema, { io: "input", target: "draft-7" }) as JsonSchema & {
        $schema?: string;
      };
      const { $schema: _ignored, ...rest } = out;
      return rest;
    } catch {
      // 落到本地转换器
    }
  }
  return convert(schema);
}

function isOptional(zodType: ZodTypeAny): boolean {
  return zodType.isOptional();
}

function unwrap(zodType: ZodTypeAny): ZodTypeAny {
  let current = zodType;
  // ZodOptional / ZodDefault / ZodNullable 的外层不影响 type 判定（nullable 保留 type）
  let guard = 0;
  while (guard++ < 10) {
    const name = current._def.typeName as string;
    if (name === "ZodOptional" || name === "ZodDefault" || name === "ZodEffects") {
      current = (current._def as { innerType: ZodTypeAny; schema?: ZodTypeAny }).innerType ??
        (current._def as { schema?: ZodTypeAny }).schema ??
        current;
      continue;
    }
    if (name === "ZodNullable") {
      current = (current._def as { innerType: ZodTypeAny }).innerType;
      continue;
    }
    break;
  }
  return current;
}

function convert(zodType: ZodTypeAny): JsonSchema {
  const name = zodType._def.typeName as string;
  const description = zodType.description;
  const withDesc = (s: JsonSchema): JsonSchema => (description ? { ...s, description } : s);

  switch (name) {
    case "ZodOptional":
    case "ZodDefault": {
      const inner = convert((zodType._def as { innerType: ZodTypeAny }).innerType);
      const def = zodType._def as { defaultValue?: unknown };
      if (name === "ZodDefault" && typeof def.defaultValue === "function") {
        try {
          return withDesc({ ...inner, default: (def.defaultValue as () => unknown)() });
        } catch {
          /* ignore */
        }
      }
      return withDesc(inner);
    }
    case "ZodNullable": {
      const inner = convert((zodType._def as { innerType: ZodTypeAny }).innerType);
      return withDesc({ ...inner, type: inner.type ? [inner.type as string, "null"] : undefined });
    }
    case "ZodString": {
      const checks = (zodType._def as { checks?: Array<{ kind: string; value?: number }> }).checks ?? [];
      const out: JsonSchema = { type: "string" };
      for (const check of checks) {
        if (check.kind === "min") out.minLength = check.value;
      }
      return withDesc(out);
    }
    case "ZodNumber": {
      const checks = (zodType._def as { checks?: Array<{ kind: string; value?: number }> }).checks ?? [];
      const isInt = checks.some((c) => c.kind === "int");
      const out: JsonSchema = { type: isInt ? "integer" : "number" };
      for (const check of checks) {
        if (check.kind === "min" && typeof check.value === "number") out.minimum = check.value;
        if (check.kind === "max" && typeof check.value === "number") out.maximum = check.value;
      }
      return withDesc(out);
    }
    case "ZodBoolean":
      return withDesc({ type: "boolean" });
    case "ZodArray": {
      const def = zodType._def as { type: ZodTypeAny };
      return withDesc({ type: "array", items: convert(def.type) });
    }
    case "ZodEnum": {
      const values = (zodType._def as { values: string[] }).values;
      return withDesc({ type: "string", enum: [...values] });
    }
    case "ZodLiteral": {
      const value = (zodType._def as { value: unknown }).value;
      return withDesc({ type: typeof value === "string" ? "string" : typeof value, enum: [value] });
    }
    case "ZodObject": {
      const shape = (zodType._def as { shape: () => Record<string, ZodTypeAny> }).shape();
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = convert(value);
        if (!isOptional(value)) required.push(key);
      }
      const out: JsonSchema = { type: "object", properties, additionalProperties: false };
      if (required.length > 0) out.required = required;
      return withDesc(out);
    }
    case "ZodRecord":
      return withDesc({ type: "object", additionalProperties: true });
    case "ZodAny":
    case "ZodUnknown":
      return withDesc({});
    default: {
      const unwrapped = unwrap(zodType);
      if (unwrapped !== zodType) return withDesc(convert(unwrapped));
      return withDesc({});
    }
  }
}

export interface ToolRegistry {
  get(name: string): AgentTool | undefined;
  list(): AgentTool[];
  toSpecs(): ToolSpec[];
}

export function createToolRegistry(tools: readonly AgentTool[]): ToolRegistry {
  const byName = new Map<string, AgentTool>();
  for (const tool of tools) {
    if (byName.has(tool.name)) {
      throw new Error(`duplicate tool name: ${tool.name}`);
    }
    byName.set(tool.name, tool);
  }
  return {
    get: (name) => byName.get(name),
    list: () => Array.from(byName.values()),
    toSpecs: () =>
      Array.from(byName.values()).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: zodToJsonSchema(tool.inputSchema as ZodTypeAny),
      })),
  };
}

// ------------------------------------------------------------------ 默认工具集

export const memorySearchInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(50).optional(),
});

export type MemorySearchInput = z.infer<typeof memorySearchInputSchema>;

export interface DefaultToolsOptions {
  maxOutputBytes?: number;
  execTimeoutMs?: number;
  /** tools.exec.envAllow 中额外允许透传的变量名。 */
  envAllow?: readonly string[];
  /** 提供时注册 memory_search 工具。 */
  memorySearch?: (query: string, limit?: number) => Promise<string[]>;
}

function createMemorySearchTool(
  search: (query: string, limit?: number) => Promise<string[]>,
): AgentTool<MemorySearchInput> {
  return {
    name: "memory_search",
    description: "Search local Markdown memory notes and return the most relevant snippets.",
    inputSchema: memorySearchInputSchema,
    riskLevel: "low",
    readOnly: true,
    async execute(input, ctx) {
      try {
        const results = await search(input.query, input.limit);
        return {
          ok: true,
          content: results.length === 0 ? "(no matches)" : results.join("\n---\n"),
          metadata: { total: results.length, taskId: ctx.taskId },
        };
      } catch (err) {
        return {
          ok: false,
          content: "",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

/**
 * 默认工具集（PM_SPEC §5.5）：read_file / list_files / search_text /
 * write_file / apply_patch / exec（+ memory_search，仅当提供 memorySearch）。
 */
export function createDefaultTools(options: DefaultToolsOptions = {}): AgentTool[] {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const execTimeoutMs = options.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const tools: AgentTool[] = [
    readFileTool as AgentTool,
    listFilesTool as AgentTool,
    searchTextTool as AgentTool,
    writeFileTool as AgentTool,
    applyPatchTool as AgentTool,
    createExecTool({
      maxOutputBytes,
      timeoutMs: execTimeoutMs,
      ...(options.envAllow ? { envAllow: options.envAllow } : {}),
    }) as AgentTool,
  ];
  if (options.memorySearch) {
    tools.push(createMemorySearchTool(options.memorySearch) as AgentTool);
  }
  return tools;
}
