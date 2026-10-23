// @agentx/tools — M2：路径安全、文件工具、受控 exec、PolicyEngine、ToolRegistry、ToolExecutor。
export const TOOLS_PACKAGE_VERSION = "0.1.0";

export { PathEscapeError, isInside, relPath, resolveInside } from "./paths.js";

export {
  applyPatchInputSchema,
  applyPatchTool,
  DEFAULT_READ_MAX_BYTES,
  DEFAULT_READ_MAX_LINES,
  LIST_MAX_ENTRIES,
  listFilesInputSchema,
  listFilesTool,
  readFileInputSchema,
  readFileTool,
  SEARCH_MAX_HITS,
  searchTextInputSchema,
  searchTextTool,
  SKIP_DIRS,
  writeFileInputSchema,
  writeFileTool,
} from "./files.js";
export type {
  ApplyPatchInput,
  ListFilesInput,
  ReadFileInput,
  SearchTextInput,
  WriteFileInput,
} from "./files.js";

export {
  buildExecEnv,
  createExecTool,
  DEFAULT_EXEC_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  ENV_ALLOWLIST,
  execInputSchema,
  execTool,
} from "./exec.js";
export type { ExecInput, ExecToolOptions } from "./exec.js";

export {
  createDispatchAgentTool,
  dispatchInputSchema,
  DEFAULT_DISPATCH_TIMEOUT_MS,
  MAX_DISPATCH_TIMEOUT_MS,
  DISPATCH_DEPTH_ENV,
} from "./dispatch.js";
export type { DispatchInput, DispatchToolOptions } from "./dispatch.js";

export { autoApprover, createPolicyEngine, summarizeToolCall } from "./policy.js";
export type { ApprovalMode, PolicyEngineOptions } from "./policy.js";

export {
  createDefaultTools,
  createToolRegistry,
  memorySearchInputSchema,
  zodToJsonSchema,
} from "./registry.js";
export type { DefaultToolsOptions, JsonSchema, MemorySearchInput, ToolRegistry } from "./registry.js";

export { createToolExecutor } from "./executor.js";
export type { ToolExecutorOptions } from "./executor.js";
