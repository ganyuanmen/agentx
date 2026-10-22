import {
  PolicyDeniedError,
  ReadOnlyViolationError,
  type AgentRequest,
  type AgentTool,
  type PolicyDecision,
  type PolicyLike,
} from "@agentx/core";

export type ApprovalMode = "none" | "high" | "all";

export interface PolicyEngineOptions {
  /** 工具名白名单（config.tools.allow）。 */
  allow: readonly string[];
  approval: ApprovalMode;
  /** 任务级只读模式（--read-only 或 config.readOnly）。 */
  readOnly: boolean;
}

/** 从工具输入里提取「一句话摘要」，用于审批提示。 */
export function summarizeToolCall(tool: AgentTool, input: unknown): string {
  if (input === null || typeof input !== "object") return tool.name;
  const obj = input as Record<string, unknown>;
  const candidates = ["path", "command", "pattern", "query"];
  for (const key of candidates) {
    const value = obj[key];
    if (typeof value !== "string" || value.trim() === "") continue;
    let text = value.replace(/\s+/g, " ").trim();
    if (key === "command") {
      const args = Array.isArray(obj.args) ? obj.args.filter((a): a is string => typeof a === "string") : [];
      if (args.length > 0) text = `${text} ${args.join(" ")}`;
    }
    if (key === "path" && typeof obj.content === "string") {
      text = `${text} (${Buffer.byteLength(obj.content, "utf8")} bytes)`;
    }
    if (text.length > 120) text = `${text.slice(0, 117)}...`;
    return text;
  }
  return tool.name;
}

/**
 * PolicyEngine（PM_SPEC §7 / D4 顺序，不可调整）：
 *  1. 白名单：不在 allow -> POLICY_DENIED（不可审批放行）
 *  2. 只读模式：工具带副作用 -> READ_ONLY_VIOLATION
 *  3. 审批条件命中 -> needApproval + prompt
 *  4. 否则放行
 */
export function createPolicyEngine(options: PolicyEngineOptions): PolicyLike {
  const allow = new Set(options.allow);

  const needsApproval = (tool: AgentTool, request: AgentRequest): boolean => {
    const mode = options.approval;
    if (mode === "none") return false;
    if (mode === "all") return tool.readOnly === false;
    // "high"
    return tool.riskLevel === "high";
  };

  return {
    async authorize({
      request,
      tool,
      input,
    }: {
      request: AgentRequest;
      tool: AgentTool;
      input: unknown;
    }): Promise<PolicyDecision> {
      // 1) 白名单
      if (!allow.has(tool.name)) {
        throw new PolicyDeniedError(
          `tool "${tool.name}" is not in the allow list (tools.allow)`,
        );
      }

      // 2) 只读模式
      const readOnly = options.readOnly || request.readOnly;
      if (readOnly && tool.readOnly === false) {
        throw new ReadOnlyViolationError(
          `tool "${tool.name}" has side effects but the task is read-only`,
        );
      }

      // 3) 审批
      if (needsApproval(tool, request)) {
        return {
          needApproval: true,
          prompt: `${tool.name} ${tool.riskLevel} 将执行：${summarizeToolCall(tool, input)}`,
        };
      }

      // 4) 放行
      return { needApproval: false };
    },
  };
}

/** 总是批准需要审批的操作（CLI --yes）。白名单与只读检查仍由 PolicyEngine 执行。 */
export const autoApprover = async (): Promise<boolean> => true;
