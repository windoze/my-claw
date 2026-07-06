# 钉钉私聊 Agent 网关设计方案

## 目标

构建一个运行在本地电脑上的单人工具，通过钉钉机器人私聊收发消息，并把用户消息转发给本地 Claude Code Agent 执行。第一阶段只支持 Claude Code；OpenCode、文件发送和卡片流式输出放到第二阶段。

## 基本约束

- 只支持钉钉机器人私聊，不支持群聊。
- 只允许配置中的指定钉钉用户使用。
- 服务端只在本地电脑运行，不暴露公网 HTTP 服务。
- 钉钉接入使用企业内部应用机器人 + Stream Mode。
- 第一阶段只接 Claude Code Agent SDK。
- 保留后端抽象，方便第二阶段接入 OpenCode。
- skill 配置优先使用 Claude Code 和 OpenCode 都兼容的 `.claude/skills` 公共格式。

## 阶段规划

### 第一阶段：Claude Code MVP

第一阶段目标是打通最小闭环：钉钉私聊入口、本地 Claude Code 会话、默认环境、项目切换和任务中断。

包含功能：

- 钉钉 Stream Mode 私聊收消息。
- 单用户 allowlist。
- 拒绝或忽略群聊消息。
- 默认环境：没有打开项目时使用默认目录和默认 Claude Code 配置。
- `/cc <dir>`：打开或切换 Claude Code 项目。
- `/close`：关闭当前项目，回到默认环境。
- `/state`：返回当前状态。
- `/stop`：中断当前正在运行的 Claude Code 任务。
- 普通消息转发给 Claude Code。
- Claude Code 完整输出以 Markdown 发送回钉钉。
- `/oc` 保留命令入口，但返回“OpenCode 尚未启用”。

暂不包含：

- OpenCode 后端。
- `/dl` 本地文件发送。
- 钉钉互动卡片或 AI Card 流式输出。
- 附件输入。
- 多用户、多群聊、多会话隔离。

### 第二阶段：OpenCode 与增强能力

第二阶段在第一阶段稳定后追加：

- `/oc <dir>`：打开或切换 OpenCode 项目。
- OpenCode session 管理。
- OpenCode SSE 事件转内部 AgentEvent。
- `/dl <path>`：从本地电脑发送文件到钉钉私聊。
- 钉钉互动卡片或 AI Card 流式输出。
- 用户发送文件/图片时转为 Agent 输入附件。
- 更丰富的工具进度展示。

## 总体架构

```text
DingTalk 私聊
  -> DingTalkAdapter
  -> SecurityGate
  -> CommandRouter
  -> SessionManager
  -> BackendAdapter
       -> ClaudeCodeAdapter
       -> OpenCodeAdapter 第二阶段
  -> OutputRenderer
  -> DingTalk Markdown/Card/File
```

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `DingTalkAdapter` | 连接钉钉 Stream Mode，接收私聊消息，发送 Markdown、文本和后续的卡片/文件 |
| `SecurityGate` | 校验私聊类型和发送人 ID，拒绝未知用户和群聊消息 |
| `CommandRouter` | 解析 slash command，并分发到具体命令处理器 |
| `SessionManager` | 管理默认环境、当前打开项目、任务运行状态和 Claude Code session |
| `BackendAdapter` | 抽象 Agent 后端接口，第一阶段只有 Claude Code 实现 |
| `ClaudeCodeAdapter` | 封装 Claude Code Agent SDK，会话创建、消息发送、输出事件和中断 |
| `OutputRenderer` | 把内部 AgentEvent 转为钉钉 Markdown；第二阶段支持卡片流式更新 |
| `StateStore` | 持久化当前环境、session ID、项目记录和运行状态快照 |
| `FileService` | 第二阶段处理 `/dl` 文件路径校验、上传和发送 |

## 推荐技术栈

- 语言：TypeScript / Node.js。
- 钉钉：官方 `dingtalk-stream` SDK。
- Claude Code：`@anthropic-ai/claude-agent-sdk`。
- 配置：`agent-dingtalk.config.jsonc`。
- 状态存储：第一阶段使用本地 JSON 文件，后续需要查询和审计时再换 SQLite。

## 配置设计

```jsonc
{
  "dingtalk": {
    "clientId": "dingxxx",
    "clientSecret": "secret",
    "robotCode": "dingbotxxx",
    "allowedUserIds": ["your-dingtalk-user-id"],
    "rejectGroupMessages": true
  },
  "defaultEnvironment": {
    "backend": "claude-code",
    "cwd": "/Users/me/work/default-agent",
    "agent": "default",
    "model": "sonnet"
  },
  "projects": [
    {
      "name": "my-app",
      "cwd": "/Users/me/repos/my-app",
      "backend": "claude-code",
      "agent": "default",
      "model": "sonnet"
    }
  ],
  "security": {
    "allowedRootDirs": ["/Users/me/repos", "/Users/me/work"]
  },
  "claudeCode": {
    "permissionMode": "acceptEdits",
    "allowedTools": ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
    "maxTurns": 20
  },
  "output": {
    "mode": "markdown",
    "maxMessageChars": 18000
  }
}
```

配置说明：

- `allowedUserIds` 是服务端强制校验，不依赖钉钉后台可见范围。
- `allowedRootDirs` 限制 `/cc` 可打开的目录，所有目录都必须 `realpath` 后落在白名单内。
- `defaultEnvironment` 是无项目打开时的默认上下文。
- `claudeCode.permissionMode` 第一阶段可先用保守配置；如果需要更强安全性，可以改为需要确认的权限模式。

## 运行状态设计

```jsonc
{
  "activeProject": {
    "cwd": "/Users/me/repos/my-app",
    "backend": "claude-code",
    "sessionId": "claude-session-id",
    "openedAt": 1730000000000
  },
  "defaultSession": {
    "cwd": "/Users/me/work/default-agent",
    "backend": "claude-code",
    "sessionId": "default-claude-session-id"
  },
  "runtime": {
    "status": "idle",
    "currentTask": null
  }
}
```

任务运行中：

```jsonc
{
  "runtime": {
    "status": "running",
    "currentTask": {
      "cwd": "/Users/me/repos/my-app",
      "backend": "claude-code",
      "startedAt": 1730000000000,
      "promptPreview": "帮我看一下这个错误..."
    }
  }
}
```

`runtime.status` 可取值：

| 状态 | 含义 |
| --- | --- |
| `idle` | 当前没有运行中的 Agent 任务 |
| `running` | Claude Code 正在处理用户消息 |
| `stopping` | 已收到 `/stop`，正在等待 Claude Code 中断完成 |

## 命令设计

| 命令 | 阶段 | 行为 |
| --- | --- | --- |
| `/cc <dir>` | 第一阶段 | 用 Claude Code 打开或切换到指定目录 |
| `/close` | 第一阶段 | 关闭当前项目，回到默认环境 |
| `/state` | 第一阶段 | 返回当前项目、默认环境、运行状态和 session 信息 |
| `/stop` | 第一阶段 | 中断当前正在运行的 Claude Code 任务 |
| `/oc <dir>` | 第二阶段 | 第一阶段返回“OpenCode 尚未启用” |
| `/dl <path>` | 第二阶段 | 从本地发送文件到钉钉私聊 |

命令示例：

```text
/cc ~/repos/my-app
/cc /Users/me/repos/my-app
/state
/stop
/close
```

## 消息路由

```text
收到钉钉消息
  -> 判断是否私聊
  -> 判断 senderId 是否在 allowedUserIds
  -> 判断是否 slash command
  -> slash command 进入 CommandRouter
  -> 普通消息进入当前环境
  -> 如果没有 activeProject，使用 defaultEnvironment
  -> 调用 ClaudeCodeAdapter.send
  -> OutputRenderer 输出 Markdown 到钉钉
```

安全校验必须在命令解析前完成。

## 私聊安全策略

第一阶段只接受私聊消息：

```ts
if (message.conversationType !== "private") {
  return
}

if (!config.dingtalk.allowedUserIds.includes(message.senderId)) {
  return
}
```

建议策略：

- 未授权用户消息静默忽略，只写本地日志。
- 群聊消息静默忽略。
- `/state` 不返回密钥、token、环境变量和完整配置。
- `/cc` 目录必须经过 `realpath`，并校验在 `allowedRootDirs` 内。
- 运行中禁止 `/cc` 和 `/close`，避免状态切换和 Agent 输出交叉。

## Claude Code 后端设计

后端统一接口：

```ts
interface BackendAdapter {
  open(env: AgentEnvironment): Promise<BackendSession>
  send(session: BackendSession, input: AgentInput): AsyncIterable<AgentEvent>
  stop(session: BackendSession): Promise<void>
  close(session: BackendSession): Promise<void>
}
```

内部事件：

```ts
type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_start"; name: string; input?: unknown }
  | { type: "tool_finish"; name: string; output?: string }
  | { type: "done"; result?: string; sessionId?: string }
  | { type: "error"; message: string }
  | { type: "stopped"; message?: string }
```

第一阶段渲染策略可以只使用 `text`、`done`、`error`、`stopped`，工具事件先记录日志或折叠到最终输出。

Claude Code SDK 使用建议：

- 用 `ClaudeSDKClient` 支持连续会话和 `interrupt()`。
- 每个环境维护一个 client/session。
- 第一次进入环境时创建 client。
- 后续消息复用该环境的 client。
- 需要持久化 `sessionId`，用于服务重启后恢复。

## `/stop` 设计

`/stop` 用于中断当前正在运行的 Claude Code 任务。

语义：

- `idle` 时收到 `/stop`：回复“当前没有运行中的任务”。
- `running` 时收到 `/stop`：切换到 `stopping`，调用 Claude SDK `interrupt()`。
- `stopping` 时再次收到 `/stop`：回复“正在中断，请稍等”。
- 中断成功后切回 `idle`，当前项目和 session 保留。
- 中断不会执行 `/close`，也不会清空默认环境。

状态流转：

```text
idle -> running -> done -> idle
idle -> running -> /stop -> stopping -> stopped -> idle
```

并发规则：

| 当前状态 | 普通消息 | `/state` | `/stop` | `/cc` `/close` |
| --- | --- | --- | --- | --- |
| `idle` | 执行 | 执行 | 提示无任务 | 执行 |
| `running` | 拒绝或提示先 `/stop` | 执行 | 执行 | 拒绝 |
| `stopping` | 拒绝 | 执行 | 提示正在中断 | 拒绝 |

MVP 建议运行中普通消息直接拒绝：

```text
Agent 正在运行，发送 /stop 可中断当前任务。
```

Claude SDK 注意事项：

- 调用 `interrupt()` 后，需要继续 drain 当前响应流直到收到结束消息。
- 不要在中断流未结束前复用同一个 client 处理新消息。
- 中断结果通常应映射为 `stopped`，而不是普通错误。

用户体验：

```text
已请求中断当前 Agent 任务。
```

中断完成后：

```text
当前 Agent 任务已中断。
```

## `/cc` 设计

流程：

```text
/cc <dir>
  -> 展开 ~ 和相对路径
  -> realpath
  -> 校验目录存在
  -> 校验目录在 allowedRootDirs 内
  -> 如果当前 status 不是 idle，拒绝切换
  -> 创建或恢复 Claude Code session
  -> 设置 activeProject
  -> 回复当前项目状态
```

如果 `<dir>` 与已打开项目相同，直接返回当前状态。

## `/close` 设计

流程：

```text
/close
  -> 如果 status 不是 idle，拒绝关闭
  -> 清空 activeProject
  -> 保留项目 sessionId 供下次 /cc 恢复
  -> 后续普通消息回到 defaultEnvironment
```

如果没有打开项目，回复：

```text
当前没有打开项目，正在使用默认环境。
```

## `/state` 设计

返回内容示例：

```text
状态：running
当前环境：项目
目录：/Users/me/repos/my-app
后端：Claude Code
Session：2f8c...ab91
当前任务：帮我看一下这个错误...
开始时间：2026-07-06 10:20:31
```

如果当前使用默认环境：

```text
状态：idle
当前环境：默认环境
目录：/Users/me/work/default-agent
后端：Claude Code
Session：default-session-id
```

## 输出渲染

第一阶段用 Markdown 完整回复：

```text
Claude Code 输出完成
  -> 聚合文本
  -> 如果长度小于 maxMessageChars，直接发 Markdown
  -> 如果过长，拆分多条 Markdown
```

第二阶段再升级为卡片流式：

```text
收到 text delta
  -> 创建互动卡片或 AI Card
  -> 每 updateThrottleMs 合并更新一次
  -> 结束时更新最终内容
  -> 失败时降级 Markdown
```

## Skill 配置

统一 skill 根目录建议使用：

```text
~/.claude/skills/<name>/SKILL.md
```

项目级 skill 使用：

```text
<project>/.claude/skills/<name>/SKILL.md
```

公共格式：

```yaml
---
name: code-review
description: Review code for correctness, security, and maintainability.
---

具体 skill 指令内容。
```

第一阶段只需保证 Claude Code 可加载。为了第二阶段兼容 OpenCode，建议避免在公共 skill 中使用 Claude Code 专有字段。

## 错误处理

| 场景 | 行为 |
| --- | --- |
| Stream Mode 断开 | 自动重连，指数退避 |
| 未授权用户 | 静默忽略并记录日志 |
| 群聊消息 | 静默忽略 |
| `/cc` 目录不存在 | 回复错误 |
| `/cc` 目录不在白名单 | 拒绝并记录安全日志 |
| Claude Code 启动失败 | 回复错误摘要，状态回到 `idle` |
| Agent 运行中收到普通消息 | 回复“Agent 正在运行，发送 /stop 可中断” |
| `/stop` 中断失败 | 回复错误摘要，尽量恢复到 `idle` |
| 输出过长 | 拆分多条 Markdown |

## 第一阶段验收标准

- 服务启动后能连接钉钉 Stream Mode。
- 只有配置的用户私聊机器人时才会触发处理。
- 普通消息在默认环境中由 Claude Code 回复。
- `/cc ~/repos/foo` 后，后续普通消息进入该项目目录的 Claude Code session。
- `/close` 后回到默认环境。
- `/state` 能显示当前状态、目录、后端和任务状态。
- 长任务运行中发送 `/stop` 能中断当前任务，并允许后续继续使用同一环境。
- 群聊消息和未知用户消息不会触发本地 Agent。

## 后续风险点

- Claude Code session 恢复依赖本地 transcript 和工作目录，服务重启后需要实测恢复行为。
- `interrupt()` 后必须正确 drain 消息流，否则 client 可能错读后续响应。
- 钉钉私聊消息字段在不同 SDK 版本中可能命名不同，需要用真实消息样本确认 `senderId` 和私聊类型字段。
- 如果第一阶段直接允许 Bash/Edit，单用户也仍然有误操作风险，建议保留明确的目录白名单和日志。
- 第二阶段卡片流式输出依赖钉钉卡片模板和接口额度，需要单独验证。
