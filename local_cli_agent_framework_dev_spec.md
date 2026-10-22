# 本地命令行 AI Agent 框架开发需求文档

-   文档版本：1.0
-   项目类型：本地运行的命令行 AI Agent 框架
-   目标读者：Agent 开发团队（架构、开发、测试、文档）
-   技术基线：Node.js + TypeScript
-   部署方式：本机进程运行；可选 Docker 用于隔离工具执行
-   明确范围：**不开发
    Gateway，不提供外部接入服务，只通过本地命令行使用**

------------------------------------------------------------------------

## 1. 项目目标

开发一个参考 OpenClaw、Hermes Agent 核心能力的本地 AI Agent
框架。框架通过命令行接收用户任务，调用大语言模型，并在受控权限范围内使用工具完成任务。第一版以稳定、可测试、易扩展为目标，不追求一次性复制现有产品的全部功能。

系统应支持：

1.  在本地终端启动、交互和执行任务。
2.  通过统一 Provider 接口接入不同模型服务，包括 OpenAI 兼容
    API、DeepSeek 和本地模型服务。
3.  让模型通过结构化工具调用使用文件、Shell 等能力。
4.  支持 Skills（技能说明与流程）、会话历史和可选长期记忆。
5.  支持任务执行循环、取消、超时、迭代次数限制和错误恢复。
6.  采用插件式设计，能够增加模型、工具和技能，而不修改核心执行循环。
7.  为后续多 Agent、任务队列、向量检索和 Docker
    沙箱预留接口，但不要求第一版全部实现。

## 2. 非目标与强制约束

### 2.1 非目标

以下功能不属于本项目第一版范围：

-   不开发 HTTP Gateway、REST API 或 WebSocket 服务。
-   不提供 Web 控制台、网页聊天界面或外部客户端接口。
-   不监听外部网络端口，不实现 Telegram、Discord 等消息渠道。
-   不建设多租户 SaaS、用户注册、计费和云端控制平面。
-   不把 Kubernetes、微服务或复杂分布式任务系统作为初始架构。
-   不默认部署独立向量数据库；仅在确有需要时扩展。

### 2.2 必须遵守的约束

-   唯一正式交互入口为本地 CLI。
-   默认只在本地终端运行，不启动对外服务。
-   核心执行逻辑不得依赖 HTTP 服务框架或网关模块。
-   模型 Provider、工具、Skills、记忆和 CLI 之间通过明确接口解耦。
-   不允许模型输出直接绕过权限检查执行 Shell、文件写入或其他副作用操作。
-   不将 API Key、密码或其他凭据写入日志、会话记录或仓库。
-   任务与工具执行必须具备超时、取消和错误处理机制。

------------------------------------------------------------------------

## 3. 推荐技术栈

  -------------------------------------------------------------------------------------
  层级                    技术                                  用途
  ----------------------- ------------------------------------- -----------------------
  运行时                  Node.js LTS、TypeScript、ESM          主开发语言与运行环境

  包管理                  pnpm workspace                        单仓库管理

  CLI                     Commander.js 或 cac                   命令解析

  交互式终端              可选：@inquirer/prompts、文字界面库   用户确认、交互输入

  Schema 校验             Zod                                   配置和工具参数校验

  日志                    Pino                                  结构化日志

  模型调用                各供应商官方 SDK 或兼容适配器         模型接入

  数据存储                SQLite（第一版推荐）                  会话、任务和元数据

  ORM/数据库访问          可选：Drizzle ORM                     SQLite 数据访问

  测试                    Vitest                                单元与集成测试

  代码规范                ESLint、Prettier                      代码质量

  浏览器自动化            Playwright（后续可选）                浏览器工具

  执行隔离                Docker（可选）                        高风险工具沙箱
  -------------------------------------------------------------------------------------

依赖应保持精简。只有在实际功能需要时才增加数据库、终端
UI、浏览器或容器依赖。

------------------------------------------------------------------------

## 4. 总体架构

``` text
本地用户
   |
   v
CLI 命令层
   |
   v
应用服务层
   |
   +--> Agent Runtime
   |      |
   |      +--> Context Builder
   |      +--> Model Router / Provider
   |      +--> Agent Loop
   |      +--> Policy / Approval
   |      +--> Result Formatter
   |
   +--> Tool Registry ------> Tool Executor
   |                             +--> 文件工具
   |                             +--> Shell 工具
   |                             +--> 搜索/浏览器工具（可选）
   |
   +--> Skill Loader
   |
   +--> Session / Memory
   |
   +--> Config / Logging
            |
            v
      本地文件系统 / SQLite
```

### 4.1 模块职责

-   **CLI**：解析命令、收集用户输入、展示执行状态和结果。
-   **应用服务层**：把 CLI 请求转换成标准任务请求，调用 Runtime。
-   **Agent Runtime**：负责一次任务的完整生命周期。
-   **Context
    Builder**：组装系统指令、用户任务、历史消息、技能内容、工具描述和检索结果。
-   **Model Provider**：负责与具体模型 API
    通信，并把结果归一化为内部事件。
-   **Agent
    Loop**：解析模型结果、执行工具、回填结果并继续调用模型，直到结束或触发停止条件。
-   **Tool Registry**：注册和查找工具定义。
-   **Tool
    Executor**：执行工具前进行参数验证、权限校验、超时控制和结果归一化。
-   **Skill Loader**：发现、解析、校验并按需加载技能。
-   **Session Store**：保存会话历史及任务元数据。
-   **Memory**：提供可选的长期记忆保存和检索能力。
-   **Policy
    Engine**：执行工具允许列表、危险操作确认、目录边界和预算限制。
-   **Logging**：记录运行过程，但必须对凭据和敏感数据脱敏。

CLI 可以直接调用应用服务层，不需要启动任何网络服务器。

------------------------------------------------------------------------

## 5. CLI 需求

命令名称暂定为 `agentx`，团队可以在实施前提出命名建议。

### 5.1 命令列表

``` bash
# 查看帮助与版本
agentx --help
agentx --version

# 一次性执行任务
agentx run "分析当前项目并指出主要问题"

# 进入交互会话
agentx chat

# 指定会话
agentx chat --session project-a

# 查看会话列表
agentx sessions list

# 查看某个会话
agentx sessions show project-a

# 删除会话（需二次确认）
agentx sessions delete project-a

# 查看模型和配置状态
agentx models list
agentx config show

# 列出工具和技能
agentx tools list
agentx skills list

# 执行诊断
agentx doctor
```

第一版至少实现
`run`、`chat`、`sessions list/show`、`tools list`、`skills list`、`config show`
和 `doctor`。其他命令可按开发进度实现。

### 5.2 CLI 行为

-   `run` 默认执行单个任务，输出最终结果和必要的执行摘要。
-   `chat` 进入交互循环，允许连续输入任务，并支持退出命令。
-   通过标准错误输出进度、调试信息和日志；标准输出保留最终回答，便于管道使用。
-   提供 `--json` 输出模式，供本地脚本读取结构化结果；这不是网络 API。
-   支持 Ctrl+C 取消当前任务，触发 AbortSignal 并尽可能停止子进程。
-   支持
    `--model`、`--session`、`--cwd`、`--max-steps`、`--timeout`、`--verbose`
    等参数。
-   非交互环境中不得无限等待人工确认；需要确认时应明确失败或使用显式的自动批准策略。
-   命令返回合适的退出码：成功为 0，参数错误为
    2，执行失败为非零，用户取消使用独立的非零退出码。

------------------------------------------------------------------------

## 6. Agent Runtime 与执行循环

### 6.1 标准执行流程

1.  接收任务输入和执行选项。
2.  创建或加载会话。
3.  检查配置、模型可用性和权限策略。
4.  构建模型上下文。
5.  调用模型并接收标准化结果。
6.  若返回最终文本，执行完成检查并结束任务。
7.  若返回工具调用，验证工具是否存在、参数是否符合
    Schema、操作是否被允许。
8.  对需要确认的操作请求用户批准。
9.  执行工具并记录结果。
10. 把工具结果加入当前任务消息，再次调用模型。
11. 在完成、取消、超时、失败或达到最大步骤时结束任务。
12. 持久化任务状态和会话记录，输出最终结果。

### 6.2 停止条件

必须实现：

-   模型给出最终答案。
-   达到最大循环步数。
-   达到任务超时时间。
-   用户通过 Ctrl+C 取消。
-   Provider 连续失败并超过重试上限。
-   工具执行不可恢复失败。
-   达到 Token 或成本预算（若 Provider 提供可用用量信息）。
-   触发安全策略拒绝执行。

循环上限和超时应可通过配置覆盖，并设置安全的默认值。

### 6.3 伪代码参考

``` ts
async function runAgent(
  request: AgentRequest,
  deps: RuntimeDependencies,
  signal?: AbortSignal,
): Promise<AgentResult> {
  const context = await deps.contextBuilder.build(request);

  for (let step = 0; step < request.maxSteps; step++) {
    if (signal?.aborted) {
      throw new TaskCancelledError();
    }

    const response = await deps.model.generate(context, { signal });

    if (response.type === "final") {
      return await deps.results.finish(request, response);
    }

    for (const call of response.toolCalls) {
      const tool = deps.tools.get(call.name);
      if (!tool) throw new UnknownToolError(call.name);

      const input = tool.inputSchema.parse(call.arguments);
      await deps.policy.authorize({ request, tool, input });

      const result = await deps.toolExecutor.execute(
        tool, input, { signal, request },
      );

      context.messages.push(
        deps.messages.toolResult(call.id, result),
      );
    }
  }

  throw new MaxStepsExceededError();
}
```

该代码仅为流程示意。实施时必须保证模型消息协议完整、工具调用 ID
对应正确、异常能转换成标准错误，并避免在失败时丢失已完成的任务记录。

------------------------------------------------------------------------

## 7. 模型 Provider 接口

定义框架内部的统一模型协议，不能在 Runtime
内直接依赖某个供应商的响应结构。

建议至少定义：

``` ts
export interface ModelProvider {
  readonly id: string;

  generate(
    request: ModelRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ModelResponse>;
}
```

如果第一版需要流式显示，再增加统一的流式接口，或者统一为
`AsyncIterable<ModelEvent>`。不要同时维护多套互不兼容的模型返回协议。

### 7.1 Provider 必须负责

-   API 认证与请求。
-   普通文本和工具调用响应解析。
-   流式事件转换（若启用）。
-   超时、有限重试和错误分类。
-   Token 使用量记录（供应商提供时）。
-   模型名称、上下文限制和能力配置。
-   将供应商专有格式转换为内部 `ModelResponse`。

### 7.2 首批支持

1.  OpenAI 兼容 API。
2.  DeepSeek API。
3.  可通过配置接入的本地模型服务。

其他 Provider 以插件方式扩展。API Key
从环境变量或本地私有配置读取，日志不得输出密钥。

------------------------------------------------------------------------

## 8. 工具系统

### 8.1 工具接口

``` ts
export interface AgentTool<TInput = unknown> {
  name: string;
  description: string;
  inputSchema: ZodType<TInput>;
  riskLevel: "low" | "medium" | "high";

  execute(
    input: TInput,
    context: ToolContext,
  ): Promise<ToolResult>;
}
```

`ToolContext` 至少包含任务
ID、工作目录、取消信号、日志接口和权限策略。工具不得自行绕过框架提供的权限检查。

### 8.2 第一版工具

-   `read_file`：读取允许访问的文件。
-   `list_files`：列出工作目录内容。
-   `write_file`：创建或更新文件。
-   `apply_patch`：按受控补丁修改文件（可选）。
-   `exec`：运行受控命令。
-   `search_text`：在工作区搜索文本。
-   `memory_search`：若记忆检索已实现则提供。

### 8.3 安全要求

-   文件工具必须阻止路径穿越，规范化真实路径，并检查符号链接越界。
-   文件写入必须受工作目录和权限策略限制。
-   Shell 工具必须使用 `spawn` 等参数数组形式执行，默认禁止通过 shell
    拼接用户或模型提供的字符串。
-   Shell 命令应有超时、输出大小上限、进程清理和工作目录限制。
-   高风险命令默认要求用户确认。
-   支持只读模式，例如 `--read-only`。
-   工具返回结构化结果，包含成功状态、输出、错误信息和必要元数据。
-   不把未经清理的完整环境变量传给子进程。
-   对工具调用次数、输出字节数和总执行时长设置上限。

Docker 沙箱可作为后续执行器实现。即使启用
Docker，也不能默认开放特权模式、宿主机 Docker Socket
或不受限的宿主机目录。

------------------------------------------------------------------------

## 9. Skills 技能系统

技能用于描述一类任务的指导流程、约束和工具使用方式，不直接替代工具实现。

### 9.1 目录约定

``` text
skills/
├── software-development/
│   └── SKILL.md
├── code-review/
│   └── SKILL.md
└── server-diagnostics/
    └── SKILL.md
```

每个 `SKILL.md`
应包含技能名称、用途、适用条件、操作步骤、约束和必要的参考文件。

### 9.2 功能要求

-   扫描内置技能目录和用户配置的本地技能目录。
-   校验文件格式、大小和路径。
-   支持列出技能及其说明。
-   根据用户指定或任务相关性选择技能。
-   按需加载技能正文，避免一次性把所有技能注入上下文。
-   记录技能来源和版本信息。
-   技能文件属于不可信输入；不得把技能中的指令当作高于系统安全策略的权限。
-   第一版不实现从网络自动安装技能。后续安装功能必须支持来源验证、审查和明确授权。

------------------------------------------------------------------------

## 10. 会话与记忆

### 10.1 会话存储

第一版推荐
SQLite，以减少部署依赖。数据访问层必须抽象为独立模块，后续可替换为
MySQL。

建议保存：

-   会话 ID、标题、创建时间、更新时间。
-   用户消息、模型响应、工具调用和工具结果。
-   任务状态、终止原因、耗时和用量。
-   使用的模型、技能和工具名称。
-   必要的错误摘要和调试元数据。

大体数据实体：

``` text
sessions
  id, title, created_at, updated_at

messages
  id, session_id, role, content, created_at

tasks
  id, session_id, status, started_at, finished_at,
  error_code, error_summary

tool_calls
  id, task_id, tool_name, arguments_json,
  result_json, status, started_at, finished_at
```

字段可由团队根据 ORM 和迁移方案调整。应建立索引、数据库迁移和备份策略。

### 10.2 长期记忆

长期记忆与会话历史分开。第一版可先支持本地 Markdown
记忆文件和简单的关键词检索；语义向量检索不是首发硬性要求。

必须明确：

-   哪些信息可以被记忆。
-   如何更新、删除和纠正记忆。
-   如何追溯记忆来源。
-   如何避免把提示词注入、错误结论或临时任务内容直接保存为长期事实。

------------------------------------------------------------------------

## 11. 配置系统

推荐配置目录：

``` text
~/.agentx/
├── config.json
├── .env
├── sessions/
├── memory/
├── skills/
├── logs/
└── data/
    └── agentx.sqlite
```

目录名应可配置；Windows、Linux 和 macOS 均需使用正确的用户数据目录规则。

配置内容建议包括：

-   默认模型和 Provider。
-   API 地址、环境变量引用和模型参数。
-   工作目录和只读模式。
-   最大步骤数、任务超时和重试上限。
-   工具允许列表、危险操作审批策略。
-   技能目录和记忆配置。
-   日志级别、日志保留期限。
-   可选沙箱执行方式。

安全要求：

-   私有配置文件应设置适当的文件权限。
-   不要将密钥写入 Git 仓库。
-   `config show` 默认对凭据脱敏。
-   配置应经过 Schema 校验，错误信息需指出具体字段。
-   环境变量可覆盖非秘密配置；密钥应优先通过环境变量或受保护的本地凭据文件提供。

------------------------------------------------------------------------

## 12. 任务状态、日志和错误处理

每次任务必须有独立的 `taskId`，并使用统一状态：

``` text
created
  -> running
  -> waiting_approval
  -> succeeded | failed | cancelled | timed_out
```

日志采用结构化格式，至少记录：

-   时间、任务 ID、会话 ID、事件类型。
-   模型调用开始/结束、耗时、错误类型。
-   工具调用开始/结束、工具名称、状态和耗时。
-   Agent Loop 当前步数。
-   任务终止原因。

默认不记录 API
Key、完整环境变量、敏感文件内容和不必要的完整提示词。日志等级至少包含
`error`、`warn`、`info`、`debug`。

必须区分可重试错误与不可重试错误。重试应有限制，并使用退避策略，避免模型
API 故障时无限调用。

------------------------------------------------------------------------

## 13. 测试要求

### 13.1 单元测试

-   配置加载、默认值和配置校验。
-   Provider 响应解析与错误映射。
-   Agent Loop 完成、工具调用、超时、取消和最大步数。
-   工具参数 Schema 校验。
-   路径穿越、符号链接和工作区边界。
-   Skill Loader 的格式、路径与加载逻辑。
-   会话保存、读取和迁移。

### 13.2 集成测试

-   使用 Mock Provider 验证完整的 Agent 执行流程。
-   验证模型连续调用多个工具。
-   验证未知工具和非法参数被拒绝。
-   验证高风险操作审批。
-   验证 Ctrl+C 和 AbortSignal 能取消任务。
-   验证应用重启后可以读取已保存的会话。
-   验证非交互模式不会意外挂起。
-   验证日志不会泄漏凭据。

### 13.3 端到端验收

至少覆盖以下任务：

1.  读取指定目录并总结文件内容。
2.  创建一个文件并验证内容正确。
3.  运行一条允许的测试命令并汇报结果。
4.  遇到未知工具时安全失败。
5.  超时后结束任务并输出清楚的错误信息。
6.  用户取消后停止后续工具调用。
7.  使用指定会话继续对话。
8.  通过 Mock Provider 完成全流程测试，不依赖真实 API 额度。

------------------------------------------------------------------------

## 14. 交付物与 Agent Team 分工

### 14.1 架构 Agent

交付：

-   模块边界和依赖关系说明。
-   内部数据协议：`ModelRequest`、`ModelResponse`、`ToolContext`、`ToolResult`、`AgentRequest`、`AgentResult`。
-   错误码、任务状态机和权限策略。
-   ADR（架构决策记录），说明关键技术选择。

### 14.2 Core Developer Agent

负责：

-   Agent Runtime。
-   Agent Loop。
-   Context Builder。
-   Provider 接口和 Mock Provider。
-   统一错误处理、取消和超时。

### 14.3 Tooling Developer Agent

负责：

-   Tool Registry。
-   文件工具和 Shell 工具。
-   参数校验、权限检查和危险操作审批。
-   工具测试与执行输出限制。

### 14.4 CLI Developer Agent

负责：

-   CLI 命令、参数解析和交互流程。
-   任务状态展示、结果输出和退出码。
-   会话、模型、工具、技能和诊断命令。

### 14.5 Persistence / Memory Agent

负责：

-   SQLite Schema 和迁移。
-   会话与任务存储。
-   本地记忆接口和基础检索。
-   数据备份与数据清理机制。

### 14.6 QA Agent

负责：

-   单元、集成和端到端测试。
-   安全边界测试。
-   中断、超时、错误恢复和凭据脱敏测试。
-   检查所有验收标准并生成测试报告。

### 14.7 协作规则

-   先由架构 Agent 定义接口和数据协议，再并行开发。
-   Core Developer 负责维护核心接口，其他 Agent 不得自行创建冲突版本。
-   每个任务必须说明修改文件范围、依赖接口、测试命令和验收标准。
-   合并前运行 lint、类型检查和测试。
-   不允许用空实现、硬编码成功结果或跳过测试的方式满足验收。
-   对接口变更必须同步更新文档和 Mock 实现。
-   由 QA Agent 最终验证完整流程，而不是仅验证各模块单独可运行。

------------------------------------------------------------------------

## 15. 推荐实施顺序

### 里程碑 M1：最小闭环

-   初始化 pnpm + TypeScript 项目。
-   完成 CLI `run`。
-   完成一个真实 Provider 和一个 Mock Provider。
-   完成 Agent Loop 和最终文本响应。
-   建立基本日志与测试。

### 里程碑 M2：工具执行

-   完成 Tool Registry。
-   实现文件读取、目录列表和受控 Shell。
-   完成 Schema 校验、审批、超时和取消。
-   增加工具调用集成测试。

### 里程碑 M3：会话与技能

-   完成 `chat` 交互模式。
-   完成 SQLite 会话存储。
-   完成 Skill Loader。
-   完成模型和技能配置。

### 里程碑 M4：可维护性与安全

-   完成任务状态持久化。
-   完成日志脱敏、错误分类和诊断命令。
-   完成安全测试和端到端验收。
-   编写安装、配置、升级和故障排查文档。

### 里程碑 M5：扩展能力（可选）

-   长期记忆与语义检索。
-   Docker 沙箱执行器。
-   Playwright 浏览器工具。
-   子 Agent 和任务委派。
-   更丰富的模型 Provider 和插件机制。

------------------------------------------------------------------------

## 16. 最终验收标准

项目只有同时满足以下条件，才可认定第一版交付：

-   [ ] 能在受支持的 Node.js 环境安装并运行。
-   [ ] 只通过本地 CLI 交互，不启动 Gateway 或对外监听端口。
-   [ ] `run` 和 `chat` 能调用模型并返回结果。
-   [ ] Agent
    能依据模型返回的结构化工具调用执行工具，并将结果反馈给模型。
-   [ ] 未知工具、非法参数和未授权操作会被拒绝。
-   [ ] 支持任务超时、最大步数和 Ctrl+C 取消。
-   [ ] 会话可以持久化并按 ID 恢复。
-   [ ] Skills 可以被发现、列出和按需加载。
-   [ ] 凭据不会出现在普通日志和版本库中。
-   [ ] 单元测试、集成测试和核心端到端测试通过。
-   [ ] 提供完整的 README、配置示例、命令说明和故障排查文档。
-   [ ]
    项目目录、接口定义和运行方式与本文档保持一致；若有偏离，须在交付前更新架构决策记录。

------------------------------------------------------------------------

## 17. 给开发团队的最终指令

请按本文档开发一个**本地优先、CLI 驱动、模块化、可扩展的 Node.js AI
Agent 框架**。

第一优先级是完成可验证的执行闭环：

**本地命令行输入任务 → 构建上下文 → 调用模型 → 解析工具调用 → 校验权限 →
执行工具 → 回传结果 → 模型完成任务 → 保存会话。**

先完成最小闭环和安全机制，再实现 Skills、长期记忆、浏览器、多 Agent
等扩展功能。

严禁在第一版中擅自引入 Gateway、HTTP 服务、WebSocket
服务、外部消息渠道或 SaaS
控制面。任何新增依赖、超出范围的功能或架构调整，都必须先说明必要性并得到项目负责人确认。
