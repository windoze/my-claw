# 钉钉私聊 Agent 网关落地计划

## 计划目标

按阶段实现 `docs/dingtalk-agent-design.md` 中定义的钉钉私聊 Agent 网关。第一阶段只实现 Claude Code 后端，优先打通稳定可用的单人私聊工作流；第二阶段再接入 OpenCode、文件发送、附件输入和卡片流式输出。

## 总体原则

- 先做可运行闭环，再做体验增强。
- 第一阶段所有能力都围绕单用户、私聊、Claude Code 展开。
- 安全校验先于命令解析和 Agent 调用。
- 状态机要简单明确：`idle`、`running`、`stopping`。
- `BackendAdapter` 接口第一阶段就保留，但只实现 `ClaudeCodeAdapter`。
- 每个阶段都要有可手工验证的验收清单。

## 里程碑 0：项目骨架与本地开发环境

目标：建立可运行、可配置、可测试的 TypeScript 服务骨架。

### 任务

1. 初始化 Node.js/TypeScript 项目。
2. 确定运行命令，例如 `npm run dev`、`npm run build`、`npm start`。
3. 增加基础目录结构：

```text
src/
  app.ts
  config/
  dingtalk/
  security/
  commands/
  session/
  backend/
  output/
  state/
  utils/
```

4. 增加基础依赖：

```text
typescript
tsx 或 ts-node
zod
jsonc-parser 或等价 JSONC 解析库
```

5. 增加配置文件样例：

```text
agent-dingtalk.config.example.jsonc
```

6. 增加 `.gitignore`，至少忽略：

```text
node_modules/
dist/
.env
agent-dingtalk.config.jsonc
.agent-dingtalk-state.json
```

7. 增加最小日志封装，支持 `debug`、`info`、`warn`、`error`。

### 产出

- 项目可以启动并读取配置。
- 配置缺失时给出明确错误。
- 配置样例覆盖第一阶段所需字段。

### 验收

- 执行开发命令后服务能启动。
- 配置文件不存在时，服务输出如何创建配置的提示。
- 配置字段错误时，服务输出字段路径和错误原因。

## 里程碑 1：配置与状态存储

目标：实现配置加载、校验、路径规范化和本地状态持久化。

### 任务

1. 定义配置 schema：

```ts
type AppConfig = {
  dingtalk: {
    clientId: string
    clientSecret: string
    robotCode?: string
    allowedUserIds: string[]
    rejectGroupMessages: boolean
  }
  defaultEnvironment: AgentEnvironmentConfig
  projects?: ProjectConfig[]
  security: {
    allowedRootDirs: string[]
  }
  claudeCode: {
    permissionMode?: string
    allowedTools?: string[]
    maxTurns?: number
  }
  output: {
    mode: "markdown"
    maxMessageChars: number
  }
}
```

2. 支持 `~` 展开。
3. 对 `defaultEnvironment.cwd` 和 `security.allowedRootDirs` 做 `realpath` 规范化。
4. 校验 `defaultEnvironment.cwd` 必须存在且是目录。
5. 校验默认目录必须位于 `allowedRootDirs` 内。
6. 实现状态文件：

```text
.agent-dingtalk-state.json
```

7. 定义状态结构：

```ts
type RuntimeStatus = "idle" | "running" | "stopping"

type AppState = {
  activeProject?: {
    cwd: string
    backend: "claude-code"
    sessionId?: string
    openedAt: number
  }
  defaultSession?: {
    cwd: string
    backend: "claude-code"
    sessionId?: string
  }
  knownProjects: Record<string, {
    backend: "claude-code"
    sessionId?: string
    lastOpenedAt?: number
  }>
  runtime: {
    status: RuntimeStatus
    currentTask?: {
      cwd: string
      backend: "claude-code"
      startedAt: number
      promptPreview: string
    } | null
  }
}
```

8. 服务启动时恢复状态，但强制把 `runtime.status` 重置为 `idle`。
9. 所有状态写入采用原子写入，避免进程崩溃时写坏 JSON。

### 产出

- `ConfigLoader`。
- `PathPolicy`。
- `StateStore`。

### 验收

- 配置中使用 `~` 能正确解析。
- 不在白名单内的目录会被拒绝。
- 状态文件损坏时，服务能备份坏文件并创建新状态，而不是直接崩溃。
- 重启服务后能恢复 `activeProject` 和 session ID，但运行状态为 `idle`。

## 里程碑 2：命令框架与核心状态机

目标：在没有真实钉钉和 Claude Code 的情况下，先打通命令解析、状态切换和并发规则。

### 任务

1. 定义统一输入消息：

```ts
type IncomingMessage = {
  id: string
  text: string
  senderId: string
  conversationType: "private" | "group" | "unknown"
  raw?: unknown
}
```

2. 定义回复接口：

```ts
interface ReplySink {
  sendMarkdown(text: string): Promise<void>
  sendText(text: string): Promise<void>
}
```

3. 实现 `CommandRouter`。
4. 实现 slash command 解析：

```text
/cc <dir>
/close
/state
/stop
/oc <dir>
```

5. 实现 `/state`。
6. 实现 `/cc <dir>` 的路径解析、白名单校验和状态切换。
7. 实现 `/close`。
8. 实现 `/oc` 第一阶段占位回复。
9. 实现 `/stop` 的状态层逻辑，真实中断留给 Claude Code 接入阶段。
10. 实现运行中并发规则：

| 状态 | 普通消息 | `/state` | `/stop` | `/cc` `/close` |
| --- | --- | --- | --- | --- |
| `idle` | 执行 | 执行 | 提示无任务 | 执行 |
| `running` | 拒绝 | 执行 | 执行 | 拒绝 |
| `stopping` | 拒绝 | 执行 | 提示正在中断 | 拒绝 |

### 产出

- `CommandRouter`。
- `SessionManager` 初版。
- `FakeReplySink` 用于本地测试。

### 验收

- 本地调用 `CommandRouter` 能正确解析命令。
- `/cc` 能设置 active project。
- `/close` 能清空 active project 并回到默认环境。
- `running` 状态下 `/cc` 和 `/close` 被拒绝。
- `/state` 不输出任何密钥或完整配置。

## 里程碑 3：钉钉 Stream Mode 接入

目标：接入真实钉钉 Stream Mode，只处理私聊和指定用户。

### 前置准备

1. 用个人钉钉账号创建测试组织，或在企业组织中获得应用开发权限。
2. 创建企业内部应用。
3. 添加机器人能力。
4. 消息接收模式选择 Stream Mode。
5. 发布应用版本。
6. 获取并配置：

```text
clientId
clientSecret
robotCode 如果接口需要
allowedUserIds
```

### 任务

1. 安装钉钉 Stream SDK。
2. 实现 `DingTalkAdapter.start()`。
3. 注册机器人消息回调。
4. 从 SDK 回调中提取：

```text
messageId
senderId
conversationType
text content
sessionWebhook 或可回复上下文
```

5. 记录第一批真实消息样本到本地 debug 日志，确认字段命名。
6. 实现 `SecurityGate`：

```text
非私聊：忽略
senderId 不在 allowedUserIds：忽略并记录 warn
空消息：忽略或回复不支持
```

7. 实现钉钉 Markdown/Text 回复。
8. 将通过安全校验的消息转给 `CommandRouter`。
9. 增加 Stream 断线重连和错误日志。

### 产出

- `DingTalkAdapter`。
- `SecurityGate`。
- 真实消息字段映射文档或注释。

### 验收

- 私聊机器人发送 `/state` 能得到状态回复。
- 未配置用户发送消息不会触发命令或 Agent。
- 群聊消息不会触发处理。
- Stream 断开后能自动重连或至少能在日志中明确提示并退出。

## 里程碑 4：Claude Code 后端接入

目标：用 Claude Code Agent SDK 实现默认环境和项目环境的真实 Agent 会话。

### 任务

1. 安装 `@anthropic-ai/claude-agent-sdk`。
2. 定义后端接口：

```ts
interface BackendAdapter {
  open(env: AgentEnvironment): Promise<BackendSession>
  send(session: BackendSession, input: AgentInput): AsyncIterable<AgentEvent>
  stop(session: BackendSession): Promise<void>
  close(session: BackendSession): Promise<void>
}
```

3. 实现 `ClaudeCodeAdapter`。
4. 每个环境维护一个 Claude SDK client。
5. 支持 `cwd`、`model`、`allowedTools`、`permissionMode`、`maxTurns`。
6. 第一次发送消息时创建 session。
7. 返回结果时保存 `sessionId` 到 `StateStore`。
8. 服务重启后，如果有 `sessionId`，尝试 resume；失败则新建 session 并提示。
9. 聚合 Claude Code 输出文本。
10. 将错误映射为用户可读消息。
11. 暂时忽略复杂工具事件，只写日志。

### 输出事件最小集

```ts
type AgentEvent =
  | { type: "text"; text: string }
  | { type: "done"; result?: string; sessionId?: string }
  | { type: "error"; message: string }
  | { type: "stopped"; message?: string }
```

### 产出

- `ClaudeCodeAdapter`。
- `BackendRegistry`，第一阶段只注册 `claude-code`。
- 默认环境和项目环境都能调用 Claude Code。

### 验收

- 无 active project 时，普通消息进入默认环境。
- `/cc <dir>` 后，普通消息进入项目目录。
- 同一环境连续提问能保留上下文。
- Claude Code 报错时服务不崩溃，状态回到 `idle`。

## 里程碑 5：`/stop` 真实中断

目标：把 `/stop` 接到 Claude Code SDK 的中断能力，确保长任务可控。

### 任务

1. 在 `SessionManager` 中保存当前运行任务对应的 `BackendSession`。
2. `/stop` 收到后检查状态：

```text
idle：回复无任务
running：进入 stopping，调用 adapter.stop
stopping：回复正在中断
```

3. 在 `ClaudeCodeAdapter.stop()` 中调用 SDK `interrupt()`。
4. 中断后继续 drain 当前响应流直到结束。
5. 将中断结果映射为 `AgentEvent.stopped`。
6. 中断完成后清空 `currentTask`，状态改回 `idle`。
7. 中断失败时记录错误，尽量恢复到 `idle`。
8. 确保中断过程中拒绝新普通消息和项目切换。

### 产出

- `/stop` 可以真实中断 Claude Code 当前任务。

### 验收

- 发起一个明显较长的任务后，发送 `/stop` 能收到“已请求中断”。
- 中断完成后收到“当前 Agent 任务已中断”。
- 中断后可以继续发送普通消息给同一环境。
- 中断后 `/state` 显示 `idle`。
- 多次 `/stop` 不会导致进程崩溃或状态错乱。

## 里程碑 6：输出渲染与消息分段

目标：保证 Claude Code 的完整输出能稳定发送到钉钉。

### 任务

1. 实现 `OutputRenderer`。
2. 按 `output.maxMessageChars` 分段。
3. 分段时优先按段落、代码块边界切分，避免 Markdown 破坏严重。
4. 增加错误摘要格式。
5. 增加运行开始提示，可选：

```text
已收到，Claude Code 正在处理...
```

6. 增加运行完成提示策略：如果最终输出为空，发送默认完成消息。
7. 增加耗时展示，可选。

### 产出

- 长输出不会发送失败。
- 用户能区分处理中、完成、中断、错误。

### 验收

- 超过单条长度限制的回复会拆成多条发送。
- 代码块回复不会明显错乱。
- Claude Code 无文本输出时也有明确完成提示。

## 里程碑 7：第一阶段端到端验收与加固

目标：完成第一阶段可日常使用的版本。

### 端到端验收清单

1. 服务启动后连接钉钉 Stream Mode。
2. 指定用户私聊 `/state` 有响应。
3. 指定用户普通消息进入默认环境并返回 Claude Code 结果。
4. `/cc ~/repos/foo` 能切换到项目目录。
5. 项目目录中的普通消息能读到该项目文件上下文。
6. `/close` 后回到默认环境。
7. 长任务运行中普通消息被拒绝并提示 `/stop`。
8. 长任务运行中 `/stop` 能中断当前任务。
9. 中断后能继续发送新任务。
10. 未授权用户不会触发处理。
11. 群聊消息不会触发处理。
12. 服务重启后能恢复 active project 和已知 session。

### 加固任务

1. 给所有外部入口加 try/catch，避免单条消息导致进程退出。
2. 为钉钉回调增加消息去重，避免重复执行同一条消息。
3. 为 Agent 任务增加超时保护，可配置。
4. 日志中脱敏 `clientSecret`、token、路径中的敏感片段。
5. 明确记录安全拒绝原因，但不回复未授权用户。
6. 增加 README 或运行说明。

### 第一阶段发布标准

- 上述端到端验收清单全部通过。
- 已知失败场景都有明确用户提示或日志。
- 进程连续运行一整天没有明显内存增长或状态错乱。

## 第二阶段：OpenCode 接入

目标：在现有 `BackendAdapter` 抽象下加入 OpenCode 后端。

### 任务

1. 安装 `@opencode-ai/sdk`。
2. 增加 `OpenCodeAdapter`。
3. 决定 OpenCode 运行模式：

```text
createOpencode 自动启动 server
或手动管理 opencode serve 进程
```

4. 实现 `/oc <dir>`。
5. 为每个 OpenCode 项目维护 server URL 和 session ID。
6. 监听 OpenCode SSE 事件。
7. 将 `message.part.updated` 映射为内部 `AgentEvent`。
8. 实现 OpenCode 中断，对应 session abort。
9. 更新 `/state` 显示后端类型。
10. 补充 OpenCode 专属错误处理。

### 验收

- `/oc <dir>` 后普通消息进入 OpenCode。
- `/cc <dir>` 和 `/oc <dir>` 可以互相切换。
- `/stop` 对 Claude Code 和 OpenCode 都生效。
- `/close` 对两种后端都能回到默认环境。

## 第二阶段：`/dl` 本地文件发送

目标：允许指定用户从本地电脑发送文件到钉钉私聊。

### 任务

1. 扩展配置：

```jsonc
{
  "security": {
    "downloadAllowedDirs": ["/Users/me/Downloads", "/Users/me/repos"],
    "maxDownloadFileBytes": 52428800
  }
}
```

2. 实现 `/dl <path>` 解析。
3. 相对路径基于当前环境 `cwd`。
4. 执行 `realpath` 并校验在 `downloadAllowedDirs` 内。
5. 校验文件存在、是普通文件、大小不超过限制。
6. 调用钉钉上传媒体或文件接口。
7. 发送文件消息到当前私聊。
8. 记录审计日志：谁、何时、发送哪个文件。

### 验收

- `/dl README.md` 能发送当前项目文件。
- 不在白名单目录内的文件被拒绝。
- 超大文件被拒绝。
- 软链逃逸被拒绝。

## 第二阶段：附件输入

目标：用户向机器人发送图片或文件时，转为 Agent 输入。

### 任务

1. 识别钉钉图片、文件消息类型。
2. 调用钉钉媒体下载接口。
3. 将附件保存到受控临时目录。
4. 限制文件大小和类型。
5. 将文件路径或内容传给 Claude Code/OpenCode。
6. 完成后定期清理临时文件。

### 验收

- 用户发送图片后，Agent 能看到图片或图片路径。
- 用户发送文本文件后，Agent 能读取文件内容。
- 不支持的文件类型有明确提示。
- 临时目录不会无限增长。

## 第二阶段：卡片流式输出

目标：用钉钉互动卡片或 AI Card 模拟流式输出效果。

### 任务

1. 确认最终使用的钉钉卡片接口和模板类型。
2. 增加配置：

```jsonc
{
  "streaming": {
    "mode": "card",
    "templateId": "xxx",
    "updateThrottleMs": 800,
    "fallbackMode": "markdown"
  }
}
```

3. 实现卡片创建。
4. 实现卡片内容更新。
5. 聚合 `AgentEvent.text`，按 `updateThrottleMs` 节流更新。
6. 任务完成时更新最终状态。
7. 卡片失败时降级为 Markdown。
8. 记录卡片 ID 和任务 ID 的映射。

### 验收

- 长回复能以卡片持续更新显示。
- 卡片更新失败时不会丢失最终回复。
- 频繁 token 输出不会触发明显限流。
- `/stop` 后卡片显示已中断。

## 测试策略

### 单元测试

- 配置解析。
- 路径白名单校验。
- 命令解析。
- 状态机流转。
- 输出分段。

### 集成测试

- 使用 fake DingTalk adapter 测试完整消息路由。
- 使用 fake BackendAdapter 测试 `/stop`、`/cc`、`/close` 并发规则。
- 使用真实 Claude Code SDK 做本地 smoke test。

### 手工验收

- 钉钉真实私聊测试。
- 长任务中断测试。
- 服务重启恢复测试。
- 未授权用户和群聊拒绝测试。

## 风险与应对

| 风险 | 应对 |
| --- | --- |
| 钉钉 SDK 消息字段与文档不一致 | 第一批消息记录 raw debug 样本，字段映射集中封装 |
| Claude Code `interrupt()` 后流未 drain 导致错乱 | `/stop` 后进入 `stopping`，直到流结束前拒绝新任务 |
| session 恢复失败 | 捕获失败，新建 session 并提示用户 |
| 本地目录误打开到敏感路径 | 所有 `/cc` 路径必须经过 `realpath` 和 `allowedRootDirs` 校验 |
| Markdown 太长发送失败 | 输出分段，必要时第二阶段支持文件化输出 |
| Stream Mode 长时间断开 | 自动重连和健康日志，后续可加本地通知 |
| 单用户工具仍可能误操作本地文件 | 默认保守权限，记录 Agent 操作日志，必要时限制 Bash/Edit |

## 建议实施顺序

1. 里程碑 0：项目骨架。
2. 里程碑 1：配置与状态。
3. 里程碑 2：命令框架和状态机。
4. 里程碑 4：Claude Code 后端，用 fake 输入先验证。
5. 里程碑 5：`/stop` 中断。
6. 里程碑 6：输出渲染。
7. 里程碑 3：钉钉 Stream Mode 接入。
8. 里程碑 7：端到端验收和加固。

说明：钉钉接入可以提前做，但建议在本地 fake 输入和 Claude Code 后端稳定后再接真实钉钉，这样问题定位更简单。
