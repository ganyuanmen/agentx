import type { ChatMessage, ToolCall, ToolResult } from "./types.js";

export function systemMessage(content: string): ChatMessage {
  return { role: "system", content };
}

export function userMessage(content: string): ChatMessage {
  return { role: "user", content };
}

export function assistantMessage(content: string, toolCalls?: ToolCall[]): ChatMessage {
  const msg: ChatMessage = { role: "assistant", content };
  if (toolCalls && toolCalls.length > 0) msg.toolCalls = toolCalls;
  return msg;
}

/** 序列化工具结果：回填给模型的 content 是固定形状的 JSON 字符串。 */
export function serializeToolResult(result: ToolResult): string {
  const payload: Record<string, unknown> = {
    ok: result.ok,
    content: result.content,
  };
  if (result.error !== undefined) payload.error = result.error;
  if (result.metadata !== undefined) payload.metadata = result.metadata;
  return JSON.stringify(payload);
}

export function toolResultMessage(callId: string, result: ToolResult): ChatMessage {
  return {
    role: "tool",
    toolCallId: callId,
    content: serializeToolResult(result),
  };
}

/**
 * 丢弃"没有配对 tool 结果"的 assistant 工具调用轮次。
 *
 * OpenAI 兼容协议要求：assistant 发出 tool_calls 后，下一条消息必须是对应
 * tool_call_id 的 tool 结果。任务因审批拒绝 / 取消 / 超时而中止时，tool_calls
 * 已写入历史但没有结果消息，若原样发给模型会被服务端以 HTTP 400 拒绝。
 *
 * 处理方式：逐个 assistant(toolCalls) 检查其后是否紧跟覆盖全部 call id 的 tool 消息，
 * 不满足则整条 assistant 消息丢弃（保留其文本内容若有）。
 */
export function dropUnpairedToolCalls(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role !== "assistant" || !msg.toolCalls || msg.toolCalls.length === 0) {
      // 孤立的 tool 结果（前面没有对应 assistant）同样丢弃
      if (msg.role === "tool") {
        const prev = out[out.length - 1];
        const belongs = prev?.role === "assistant" && prev.toolCalls?.some((c) => c.id === msg.toolCallId);
        const prevTool =
          out.length >= 2 &&
          prev?.role === "tool" &&
          out[out.length - 2]?.role === "assistant" &&
          out[out.length - 2]?.toolCalls?.some((c) => c.id === msg.toolCallId);
        if (!belongs && !prevTool) continue;
      }
      out.push(msg);
      continue;
    }

    const expected = new Set(msg.toolCalls.map((c) => c.id));
    const collected = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j]?.role === "tool") {
      const id = messages[j]?.toolCallId;
      if (id) collected.add(id);
      j++;
    }
    const complete = [...expected].every((id) => collected.has(id));
    if (!complete) {
      // 保留 assistant 的文本（若有），去掉 toolCalls，避免协议违规
      if (msg.content && msg.content.trim() !== "") {
        out.push({ role: "assistant", content: msg.content });
      }
      // 跳过这些不配对的 tool 结果
      i = j - 1;
      continue;
    }
    out.push(msg);
  }
  return out;
}

/**
 * 保留最近 maxMessages 条消息，同时保证 role="tool" 消息不会与其对应的
 * assistant(toolCalls) 被拆开：从尾部向前收集，遇到 tool 消息时继续向前
 * 纳入紧邻的 assistant 工具调用消息。
 */
export function truncateHistory(messages: ChatMessage[], maxMessages: number): ChatMessage[] {
  if (!Number.isFinite(maxMessages) || maxMessages < 0) return [];
  if (maxMessages === 0) return [];
  if (messages.length <= maxMessages) return [...messages];

  let start = messages.length - maxMessages;
  // 若保留区首条是 tool 消息，则向前扩展到包含其所属的 assistant(toolCalls)。
  while (start > 0 && messages[start]?.role === "tool") {
    let idx = start - 1;
    while (idx >= 0) {
      const candidate = messages[idx];
      if (candidate?.role === "assistant" && candidate.toolCalls && candidate.toolCalls.length > 0) {
        break;
      }
      if (candidate?.role === "tool") break;
      idx--;
    }
    if (idx < 0) break;
    const next = idx;
    if (next >= start) break;
    start = next;
  }
  return messages.slice(start);
}
