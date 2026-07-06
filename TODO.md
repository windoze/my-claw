# 钉钉私聊 Agent 网关任务列表

## 状态约定

任务标题格式为 `Txx [TODO] 任务名`。coding agent 执行时可以把 `[TODO]` 更新为 `[IN_PROGRESS]`、`[DONE]` 或 `[BLOCKED]`。

## T01 [DONE] 初始化 TypeScript 项目骨架

阶段：第一阶段，项目基础。

目标：创建可运行的 Node.js/TypeScript 项目，为后续模块实现提供基础结构。

涉及文件：`package.json`、`tsconfig.json`、`.gitignore`、`src/app.ts`、`src/index.ts`、`src/config/`、`src/dingtalk/`、`src/security/`、`src/commands/`、`src/session/`、`src/backend/`、`src/output/`、`src/state/`、`src/utils/`。

实现细节：初始化 `package.json`，设置项目模块格式并保持全项目一致；添加脚本 `dev`、`build`、`start`、`typecheck`；安装基础依赖 `typescript`、`tsx`、`zod`、`jsonc-parser`；创建上述目录；`src/index.ts` 只负责启动应用并捕获顶层错误；`src/app.ts` 导出 `startApp()`，当前可只输出启动日志。

实现细节：`.gitignore` 至少忽略 `node_modules/`、`dist/`、`.env`、`agent-dingtalk.config.jsonc`、`.agent-dingtalk-state.json`、`.agent-dingtalk-state.json.tmp`、日志文件。

验收：运行 `npm run typecheck` 通过；运行 `npm run build` 通过；运行 `npm run dev` 能启动并输出一条明确的启动日志。

完成记录：2026-07-06 完成 Node.js/TypeScript 项目骨架，包含一致的 ESM 模块配置、`dev`/`build`/`start`/`typecheck` 脚本、基础依赖、必需源码目录、顶层启动入口和启动日志。已验证 `npm run typecheck`、`npm run build`、`npm run dev` 和 `npm start` 通过。

## T02 [DONE] 增加配置样例和配置类型

阶段：第一阶段，配置基础。

目标：提供第一阶段可用的配置文件样例和 TypeScript 类型定义。

涉及文件：`agent-dingtalk.config.example.jsonc`、`src/config/types.ts`。

实现细节：配置样例必须覆盖 `dingtalk.clientId`、`dingtalk.clientSecret`、`dingtalk.robotCode`、`dingtalk.allowedUserIds`、`dingtalk.rejectGroupMessages`、`defaultEnvironment.backend`、`defaultEnvironment.cwd`、`defaultEnvironment.agent`、`defaultEnvironment.model`、`projects`、`security.allowedRootDirs`、`claudeCode.permissionMode`、`claudeCode.allowedTools`、`claudeCode.maxTurns`、`output.mode`、`output.maxMessageChars`。

实现细节：`src/config/types.ts` 定义 `AppConfig`、`AgentEnvironmentConfig`、`ProjectConfig`、`DingTalkConfig`、`SecurityConfig`、`ClaudeCodeConfig`、`OutputConfig`。第一阶段 `backend` 只允许 `claude-code`，但类型命名要方便第二阶段扩展 `opencode`。

验收：配置样例可以直接复制为 `agent-dingtalk.config.jsonc` 并被后续 `ConfigLoader` 使用；类型文件不依赖具体实现模块，避免循环依赖。

完成记录：2026-07-06 新增 `agent-dingtalk.config.example.jsonc`，覆盖钉钉凭证、默认环境、项目样例、安全白名单、Claude Code 设置和输出设置；新增 `src/config/types.ts`，定义配置结构类型且不依赖具体实现模块。已验证配置样例可被 `jsonc-parser` 解析，`npm run typecheck` 和 `npm run build` 通过。

## T03 [DONE] 实现配置加载和 Zod 校验

阶段：第一阶段，配置基础。

目标：从 JSONC 文件读取配置，完成结构校验并输出清晰错误。

涉及文件：`src/config/schema.ts`、`src/config/loadConfig.ts`、`src/config/index.ts`、`src/app.ts`。

实现细节：默认配置路径为项目根目录 `agent-dingtalk.config.jsonc`；允许通过环境变量 `AGENT_DINGTALK_CONFIG` 指定配置路径；使用 `jsonc-parser` 解析 JSONC；使用 `zod` 校验配置；校验失败时输出字段路径、错误原因和配置文件路径；配置文件缺失时提示复制 `agent-dingtalk.config.example.jsonc`。

实现细节：为 `output.maxMessageChars` 设置合理默认值，例如 `18000`；为 `dingtalk.rejectGroupMessages` 设置默认 `true`；为 `claudeCode.maxTurns` 设置默认值，例如 `20`；禁止 `allowedUserIds` 为空。

验收：缺少配置文件时进程失败并给出可执行提示；配置字段类型错误时给出字段路径；合法配置可以成功加载为 `AppConfig`。

完成记录：2026-07-06 实现 `src/config/schema.ts`、`src/config/loadConfig.ts` 和 `src/config/index.ts`，支持默认 `agent-dingtalk.config.jsonc`、`AGENT_DINGTALK_CONFIG` 覆盖、JSONC 解析、Zod 结构校验、字段路径错误、缺失配置复制样例提示，以及 `rejectGroupMessages`、`claudeCode.maxTurns`、`output.maxMessageChars` 默认值；`src/app.ts` 启动时加载合法配置后再输出启动日志。已验证 `npm run typecheck`、`npm run build`、缺失配置、字段类型错误、样例配置加载和默认值省略场景。

## T04 [DONE] 实现路径解析和目录白名单策略

阶段：第一阶段，安全基础。

目标：统一处理 `~`、相对路径、`realpath` 和 allowed root 校验，供默认环境、`/cc` 和第二阶段 `/dl` 使用。

涉及文件：`src/utils/path.ts`、`src/security/PathPolicy.ts`、`src/config/loadConfig.ts`。

实现细节：实现 `expandHome(path)`、`resolveUserPath(input, baseDir?)`、`realpathDir(path)`、`isPathInside(child, parent)`；`isPathInside` 必须基于规范化绝对路径比较，避免 `..` 绕过；处理软链时以 `realpath` 结果为准。

实现细节：`PathPolicy` 持有规范化后的 `allowedRootDirs`；提供 `assertAllowedDir(dir)`；错误消息区分目录不存在、不是目录、不在白名单内；`defaultEnvironment.cwd` 必须存在且在 `allowedRootDirs` 内。

验收：`~/repo` 能正确展开；不在白名单内的目录被拒绝；指向白名单外的软链目录被拒绝；合法目录通过校验。

完成记录：2026-07-06 实现 `src/utils/path.ts` 和 `src/security/PathPolicy.ts`，统一支持 `~` 展开、相对路径解析、目录 `realpath`、规范化包含关系判断、目录白名单校验，以及不存在、非目录、不在白名单内的明确错误；`loadConfig` 现在支持配置文件路径 `~` 展开，会将 `security.allowedRootDirs` 和 `defaultEnvironment.cwd` 规范化为真实路径，并拒绝不在白名单内的默认目录。已验证 `npm run typecheck`、`npm run build`、`~` 展开、配置文件路径 `~` 展开、相对路径解析、合法目录通过、不在白名单内目录拒绝、缺失目录拒绝、非目录拒绝、软链逃逸拒绝。

## T05 [DONE] 实现本地状态存储 StateStore

阶段：第一阶段，状态基础。

目标：持久化当前打开项目、默认 session、已知项目 session 和运行状态。

涉及文件：`src/state/types.ts`、`src/state/StateStore.ts`、`src/state/index.ts`。

实现细节：状态文件默认为项目根目录 `.agent-dingtalk-state.json`；定义 `RuntimeStatus = "idle" | "running" | "stopping"`；定义 `AppState`，包含 `activeProject`、`defaultSession`、`knownProjects`、`runtime`；服务启动读取状态后强制设置 `runtime.status = "idle"` 且 `currentTask = null`。

实现细节：写入状态必须使用临时文件加 rename 的原子写入模式；状态文件不存在时创建默认状态；状态 JSON 损坏时备份为 `.agent-dingtalk-state.json.bak.<timestamp>`，然后创建默认状态并记录 warn 日志。

验收：状态能读写；进程重启后能恢复 `activeProject` 和 `knownProjects`；损坏状态文件不会导致服务直接崩溃；运行状态总是在启动时恢复为 `idle`。

完成记录：2026-07-06 实现 `src/state/types.ts`、`src/state/StateStore.ts` 和 `src/state/index.ts`，定义 `RuntimeStatus`、`AppState`、默认 session、已知项目和运行任务状态；`StateStore` 默认使用项目根目录 `.agent-dingtalk-state.json`，支持缺失状态文件自动创建、临时文件加 rename 原子写入、损坏或结构无效状态文件备份为 `.agent-dingtalk-state.json.bak.<timestamp>` 后重建默认状态并输出 warn；启动加载会保留 `activeProject`、`defaultSession` 和 `knownProjects`，同时强制恢复 `runtime.status = "idle"` 且 `currentTask = null` 并持久化。`startApp()` 已接入启动状态加载。已验证 `npm run typecheck`、`npm run build`，以及缺失状态创建、状态读写、重启恢复项目/session、运行状态恢复为 idle、损坏 JSON 备份并重建默认状态、原子写入临时文件清理场景。

## T06 [DONE] 增加日志工具和错误类型

阶段：第一阶段，基础设施。

目标：提供统一日志和可分类错误，避免各模块直接 `console.log` 或抛出难以识别的错误。

涉及文件：`src/utils/logger.ts`、`src/utils/errors.ts`、`src/app.ts`。

实现细节：实现 `createLogger(scope)`，输出包含时间、级别、scope 和消息；支持 `debug`、`info`、`warn`、`error`；日志中必须避免打印 `clientSecret`、token、完整环境变量；实现 `AppError` 基类，至少包含 `code`、`message`、`cause?`、`safeMessage?`；实现 `UserFacingError` 用于可以直接回复给钉钉用户的错误。

实现细节：顶层启动异常由 `src/index.ts` 捕获并通过 logger 输出；后续消息处理异常必须由调用方捕获，不能让单条消息导致进程退出。

验收：模块可以创建带 scope 的 logger；`UserFacingError.safeMessage` 可以直接用于用户回复；敏感字段不会被默认日志格式输出。

完成记录：2026-07-06 实现 `src/utils/logger.ts` 和 `src/utils/errors.ts`，提供带时间、级别、scope、消息的 `createLogger(scope)`，支持 `debug`、`info`、`warn`、`error`，默认对 `clientSecret`、token、Authorization、密码、API key 和完整环境变量对象做脱敏；新增 `AppError` 和 `UserFacingError`，并让现有配置、路径、白名单和状态存储错误继承可分类错误基类；`src/index.ts` 顶层启动异常改为通过 scoped logger 输出，`src/app.ts` 和 `StateStore` 不再直接使用 console 输出。已验证 `npm run typecheck`、`npm run build`、logger 时间/级别/scope/消息格式、敏感字段脱敏和 `UserFacingError.safeMessage`。

## T07 [DONE] 定义统一消息、回复和 Agent 环境类型

阶段：第一阶段，接口基础。

目标：固定内部模块之间的数据结构，让钉钉适配器、命令路由、SessionManager 和后端实现解耦。

涉及文件：`src/messages/types.ts`、`src/output/types.ts`、`src/session/types.ts`、`src/backend/types.ts`。

实现细节：定义 `IncomingMessage`，字段包含 `id`、`text`、`senderId`、`conversationType: "private" | "group" | "unknown"`、`raw?`、`replyContext?`；定义 `ReplySink`，包含 `sendText(text)`、`sendMarkdown(markdown)`；定义 `AgentEnvironment`，包含 `backend: "claude-code"`、`cwd`、`agent?`、`model?`、`sessionId?`、`kind: "default" | "project"`。

实现细节：定义 `AgentInput`，第一阶段只包含 `text` 和 `messageId`；定义 `AgentEvent` 最小集：`text`、`done`、`error`、`stopped`；保留 `tool_start`、`tool_finish` 类型但第一阶段可只记录日志。

验收：各类型文件不导入具体实现类；后续所有模块都使用这些公共类型通信。

完成记录：2026-07-06 新增 `src/messages/types.ts`、`src/output/types.ts`、`src/session/types.ts` 和 `src/backend/types.ts`，定义统一 `IncomingMessage`、`ReplySink`、`AgentEnvironment`、`AgentInput`、`AgentEvent` 及保留的 `tool_start`/`tool_finish` 事件类型；类型文件仅依赖公共类型，不导入具体实现类，为后续钉钉适配器、命令路由、SessionManager、输出渲染和后端适配器提供共享通信契约。已验证 `npm run typecheck` 和 `npm run build` 通过。

## T08 [DONE] 实现 slash command 解析器

阶段：第一阶段，命令基础。

目标：将用户输入解析为命令名和参数，支持第一阶段命令。

涉及文件：`src/commands/parseCommand.ts`、`src/commands/types.ts`。

实现细节：只有以 `/` 开头的非空文本被识别为命令；命令名取第一个空白前的内容并转小写；保留原始参数字符串 `argsText`；第一阶段识别 `/cc`、`/close`、`/state`、`/stop`、`/oc`；未知 slash command 返回 `unknown`，由 `CommandRouter` 回复不支持。

实现细节：参数解析不需要完整 shell parser，但必须支持路径中包含空格的基本场景，建议支持引号包裹，例如 `/cc "/Users/me/My Repo"`；如果暂不支持复杂引号，要在错误提示中说明。

验收：`/state` 解析为命令无参数；`/cc ~/repos/foo` 解析出 `~/repos/foo`；普通文本不被识别为命令；未知 `/abc` 能被识别为未知命令。

完成记录：2026-07-06 新增 `src/commands/types.ts` 和 `src/commands/parseCommand.ts`，定义第一阶段 slash command 类型、已知命令集合、未知命令和无效命令解析结果；实现 `parseCommand()`，只识别以 `/` 开头的非空文本，命令名按第一个空白切分并转小写，保留 `argsText`，识别 `/cc`、`/close`、`/state`、`/stop`、`/oc`，并把未知 `/abc` 归类为 `unknown`；实现基础参数切分，支持引号包裹的空格路径并对未闭合引号返回明确错误。同时修复 `src/utils/logger.ts` 中阻塞编译的 Bearer token 脱敏字符串语法错误。已验证 `npm run typecheck`、`npm run build`，以及 `/state`、`/cc ~/repos/foo`、普通文本、未知 `/abc`、引号空格路径和未闭合引号场景。

## T09 [DONE] 实现 CommandRouter 框架

阶段：第一阶段，命令基础。

目标：为所有 slash command 提供统一分发、错误处理和回复入口。

涉及文件：`src/commands/CommandRouter.ts`、`src/commands/handlers.ts`、`src/commands/index.ts`。

实现细节：`CommandRouter.handle(message, replySink)` 先调用 `parseCommand`；非命令返回 `false`，让上层继续走普通 Agent 消息；命令已处理返回 `true`；所有 handler 抛出的 `UserFacingError` 要回复 `safeMessage`；其他异常回复通用错误并记录详细日志。

实现细节：先实现 `/state` 占位、`/oc` 占位、未知命令回复；`/cc`、`/close`、`/stop` 具体逻辑可以调用后续 `SessionManager`。

验收：通过 fake message 和 fake reply 可以验证每个命令会进入对应 handler；未知命令不会触发 Agent 后端。

完成记录：2026-07-06 新增 `src/commands/CommandRouter.ts`、`src/commands/handlers.ts` 和 `src/commands/index.ts`，实现 `CommandRouter.handle(message, replySink)` 统一调用 `parseCommand`、对非命令返回 `false`、对已处理命令返回 `true`，并分发 `/state`、`/oc`、`/cc`、`/close`、`/stop`、未知命令和非法命令；默认 handler 提供 `/state`、`/oc` 和 SessionManager 相关命令占位回复，未知命令不会落入普通 Agent 消息；handler 抛出 `UserFacingError` 时回复 `safeMessage`，其他异常记录详细日志并回复通用错误。已验证 `npm run typecheck`、`npm run build`，以及 fake message/fake reply 覆盖非命令、`/state`、`/oc`、未知命令、非法命令、所有已知命令分发、`UserFacingError.safeMessage` 和通用异常日志路径。

## T10 [DONE] 实现 SessionManager 的环境选择和状态机

阶段：第一阶段，会话管理。

目标：管理默认环境、当前项目、运行状态、并发规则和状态持久化。

涉及文件：`src/session/SessionManager.ts`、`src/session/types.ts`、`src/state/StateStore.ts`。

实现细节：`getCurrentEnvironment()` 在有 `activeProject` 时返回项目环境，否则返回 `defaultEnvironment`；`openClaudeProject(dir)` 校验状态必须为 `idle`，通过 `PathPolicy` 校验目录，设置 `activeProject` 并更新 `knownProjects`；`closeProject()` 校验状态必须为 `idle`，清空 `activeProject` 但保留 `knownProjects[cwd].sessionId`；`getStateSummary()` 返回可用于 `/state` 的脱敏状态。

实现细节：提供 `canAcceptNormalMessage()`；状态为 `running` 或 `stopping` 时普通消息拒绝；状态为 `running` 或 `stopping` 时 `/cc` 和 `/close` 拒绝；`/state` 总是允许；`/stop` 在不同状态下按设计返回。

验收：无 active project 时当前环境是默认环境；`/cc` 后当前环境切为项目；`/close` 后回默认环境；运行中切换项目被拒绝；状态变更都会写入 `StateStore`。

完成记录：2026-07-06 新增 `src/session/SessionManager.ts` 和 `src/session/index.ts`，实现默认环境与 active project 环境选择、`openClaudeProject(dir)` 路径白名单校验与 `activeProject`/`knownProjects` 持久化、`closeProject()` 回到默认环境并保留项目 session、脱敏 `getStateSummary()`、普通消息与 `/cc`/`/close` 的运行态拒绝规则、`/state`/`/stop` 可用性判断、运行任务 `running`/`stopping`/`idle` 状态迁移以及默认/项目 sessionId 保存。已验证 `npm run typecheck`、`npm run build`，并通过本地 `tsx` acceptance 检查覆盖默认环境、`/cc` 切换项目、`/close` 回默认、运行中拒绝切换、运行中优先返回忙碌错误、停止状态决策、项目 session 保留、状态摘要 sessionId 脱敏和白名单外目录拒绝。

## T11 [DONE] 实现第一阶段命令处理器

阶段：第一阶段，命令功能。

目标：完成 `/state`、`/cc`、`/close`、`/stop` 的状态层行为和 `/oc` 占位。

涉及文件：`src/commands/handlers.ts`、`src/session/SessionManager.ts`、`src/output/formatState.ts`。

实现细节：`/state` 调用 `SessionManager.getStateSummary()` 并格式化为 Markdown；`/cc <dir>` 参数缺失时回复用法，参数存在时调用 `openClaudeProject`；`/close` 调用 `closeProject`；`/stop` 在真实后端接入前只完成状态判断，`idle` 回复无任务，`running` 调用后续注入的 stop 回调，`stopping` 回复正在中断；`/oc` 回复 `OpenCode 尚未启用，将在第二阶段支持。`

实现细节：`/state` 输出不能包含 `clientSecret`、完整配置、环境变量；session ID 可以截断显示，例如只显示前 8 位和后 4 位。

验收：所有命令通过 fake reply 返回预期文本；`/cc` 参数为空有明确用法提示；`/oc` 不改变状态。

完成记录：2026-07-06 实现 `src/output/formatState.ts`，将 `SessionManager.getStateSummary()` 渲染为不包含 `clientSecret`、完整配置或环境变量的 Markdown 状态摘要，并截断显示 session ID；新增 SessionManager 驱动的命令处理器，完成 `/state`、`/cc <dir>`、`/close`、`/stop` 状态层行为和 `/oc` 第二阶段占位回复；`CommandRouter` 支持注入 `SessionManager` 与后续后端 stop 回调，`/cc` 和 `/close` 在运行中优先返回忙碌拒绝，`/cc` 参数缺失返回明确用法，路径白名单错误可安全回复给用户。已验证 `npm run typecheck`、`npm run build`，并通过本地 `tsx` fake reply acceptance 覆盖 `/state`、`/cc` 缺参、带空格路径切换、运行中拒绝切换、白名单外目录拒绝、session ID 脱敏、`/close`、`/stop` idle/running/stopping 和 `/oc` 不改变状态。

## T12 [DONE] 增加 FakeReplySink 和 FakeBackend 便于本地集成测试

阶段：第一阶段，本地验证。

目标：在接入真实钉钉和 Claude Code 前，用 fake 组件验证消息路由、命令和状态机。

涉及文件：`src/testing/FakeReplySink.ts`、`src/testing/FakeBackendAdapter.ts`、`src/testing/runFakeMessage.ts` 或等价脚本。

实现细节：`FakeReplySink` 保存所有 `sendText` 和 `sendMarkdown` 调用到数组；`FakeBackendAdapter.send` 返回固定 `AgentEvent.text` 和 `AgentEvent.done`；提供一个本地脚本或函数，可以构造 `IncomingMessage` 并经过 `CommandRouter` 和普通消息路由。

实现细节：如果项目暂不引入测试框架，至少提供一个开发脚本用于手工运行 fake 消息；后续可替换为 Vitest。

验收：不用钉钉、不用 Claude Code，也能验证 `/state`、`/cc`、`/close`、普通消息转 fake 后端的完整路径。

完成记录：2026-07-06 新增 `src/testing/FakeReplySink.ts`，按调用顺序记录 `sendText`/`sendMarkdown`，并提供独立 text/Markdown 回复数组；新增 `src/testing/FakeBackendAdapter.ts`，记录发送请求并返回固定 `AgentEvent.text` 与 `AgentEvent.done`；新增 `src/testing/runFakeMessage.ts` 和 `src/testing/index.ts`，可构造 fake `IncomingMessage`，通过真实 `CommandRouter`、`SessionManager` 和普通消息 fake 后端路径执行本地验证；新增 `npm run fake:message` 开发脚本，默认或显式消息均可在无钉钉、无 Claude Code 情况下验证 `/state`、`/cc`、普通消息和 `/close` 完整路径。已验证 `npm run typecheck`、`npm run build` 和 `npm run fake:message -- "/state" "/cc ." "hello fake backend" "/close"` 通过。

## T13 [DONE] 定义 BackendAdapter 与 BackendRegistry

阶段：第一阶段，后端抽象。

目标：固定 Agent 后端接口，第一阶段只注册 Claude Code，第二阶段无重构接入 OpenCode。

涉及文件：`src/backend/types.ts`、`src/backend/BackendRegistry.ts`、`src/backend/index.ts`。

实现细节：定义 `BackendAdapter.open(env)`、`send(session, input)`、`stop(session)`、`close(session)`；定义 `BackendSession`，至少包含 `backend`、`cwd`、`sessionId?`、`raw?`；`BackendRegistry` 根据 `AgentEnvironment.backend` 返回 adapter；第一阶段未知 backend 直接抛 `UserFacingError`。

实现细节：`send` 必须返回 `AsyncIterable<AgentEvent>`，即使第一阶段内部聚合输出，也要保持事件流接口。

验收：`BackendRegistry` 能注册和获取 `claude-code` adapter；未知 backend 错误可被用户安全展示。

完成记录：2026-07-06 定义 `BackendSession` 和 `BackendAdapter` 统一后端生命周期接口，固定 `open(environment)`、`send(session, input)`、`stop(session)`、`close(session)`，并要求 `send` 返回 `AsyncIterable<AgentEvent>`；新增 `BackendRegistry` 和 backend 公共导出，支持注册并解析 `claude-code` adapter，未注册或未知 backend 会抛出可直接展示的 `UserFacingError`；更新 FakeBackendAdapter 与 fake-message 本地路由，使普通消息通过 registry 执行 `open -> send` 事件流 -> `close`，继续支持无钉钉、无 Claude Code 的本地集成验证。已验证 `npm run typecheck`、`npm run build`、`npm run fake:message -- "/state" "/cc ." "hello fake backend" "/close"`，以及 focused registry check 覆盖 `claude-code` adapter 解析和 `opencode` 未支持错误安全展示。

## T14 [DONE] 接入 Claude Code Agent SDK 基础调用

阶段：第一阶段，Claude Code 后端。

目标：实现 `ClaudeCodeAdapter` 的最小可用版本，可以在指定 `cwd` 发送 prompt 并得到完整结果。

涉及文件：`src/backend/claude/ClaudeCodeAdapter.ts`、`src/backend/claude/types.ts`、`src/backend/index.ts`、`package.json`。

实现细节：安装 `@anthropic-ai/claude-agent-sdk`；`ClaudeCodeAdapter` 从配置读取 `allowedTools`、`permissionMode`、`maxTurns`；调用 SDK 时设置 `cwd`；捕获 SDK 的 result message 并映射为 `AgentEvent.done`；中间文本如果可直接获得则映射为 `AgentEvent.text`，否则第一版可以只在 `done.result` 输出完整文本。

实现细节：不要在 adapter 内直接发钉钉消息；adapter 只产出 `AgentEvent`；错误要映射为 `AgentEvent.error` 或抛 `UserFacingError`。

验收：用本地脚本调用 `ClaudeCodeAdapter.send`，传入简单问题，能得到 Claude Code 回复；`cwd` 指向不同目录时，Claude Code 能在对应目录工作。

完成记录：2026-07-06 安装 `@anthropic-ai/claude-agent-sdk`，新增 `src/backend/claude/ClaudeCodeAdapter.ts`、`src/backend/claude/types.ts`、`src/backend/claude/index.ts` 和 `npm run claude:prompt` 本地脚本；`ClaudeCodeAdapter` 从 `claudeCode` 配置读取 `allowedTools`、`permissionMode`、`maxTurns`，调用 SDK `query()` 时设置 `cwd`、`agent`、`model`，将流式文本 delta 映射为 `AgentEvent.text`，将 SDK result success 映射为 `AgentEvent.done` 和 sessionId，将 SDK/运行错误映射为 `AgentEvent.error`，并提供基础 stop/close 资源清理；配置校验现在限制 Claude Code permission mode 为 SDK 支持值。已验证 `npm run typecheck`、`npm run build`、配置样例加载、`npm run fake:message -- "/state" "/cc ." "hello fake backend" "/close"`、`npm run claude:prompt -- --max-turns 1 --cwd . "请只回复：OK"`，以及在临时目录通过 `pwd` 工具确认 `cwd` 生效。

## T15 [TODO] 实现 Claude Code session 保存和恢复

阶段：第一阶段，Claude Code 后端。

目标：同一默认环境或项目环境的连续消息能复用上下文，服务重启后尽量恢复 session。

涉及文件：`src/backend/claude/ClaudeCodeAdapter.ts`、`src/session/SessionManager.ts`、`src/state/StateStore.ts`。

实现细节：adapter 在收到 SDK result 后提取 `sessionId`；`SessionManager` 根据当前环境把 session ID 保存到 `defaultSession.sessionId` 或 `knownProjects[cwd].sessionId`；再次进入同一环境时，把 session ID 放入 `AgentEnvironment.sessionId` 并让 adapter 尝试 resume；resume 失败时记录 warn，新建 session，并通过 `AgentEvent.text` 或用户提示说明已创建新会话。

实现细节：如果使用 `ClaudeSDKClient` 保持长连接，需要维护 `cwd -> client` 映射；如果使用 `query()`，需要明确传递 `resume`；实现方式必须与 `/stop` 的中断需求兼容。

验收：连续问两条相关问题，第二条能引用第一条上下文；重启服务后同目录 session 能恢复或在失败时明确提示并新建。

## T16 [TODO] 打通普通消息到 Claude Code 的本地路由

阶段：第一阶段，核心链路。

目标：非命令消息进入当前环境，通过 Claude Code 执行，并由 ReplySink 返回结果。

涉及文件：`src/app.ts`、`src/session/SessionManager.ts`、`src/backend/BackendRegistry.ts`、`src/output/OutputRenderer.ts`。

实现细节：实现 `handleIncomingMessage(message, replySink)`；先交给 `CommandRouter`，已处理则结束；普通消息先检查 `SessionManager.canAcceptNormalMessage()`；设置 `runtime.status = "running"` 和 `currentTask`；调用当前环境 backend；收集 `AgentEvent`；完成或错误后清理 `currentTask` 并回到 `idle`。

实现细节：普通消息运行中再次收到普通消息，要回复 `Agent 正在运行，发送 /stop 可中断当前任务。`；所有 finally 块必须保证状态恢复，除非当前正在 `stopping` 并由 stop 流程接管。

验收：fake 输入普通消息能触发 Claude Code；运行状态从 `idle` 到 `running` 再到 `idle`；失败时状态也回 `idle`。

## T17 [TODO] 实现 `/stop` 对 Claude Code 的真实中断

阶段：第一阶段，任务控制。

目标：把 `/stop` 接到 Claude Code SDK 的中断能力，确保长任务可控。

涉及文件：`src/backend/claude/ClaudeCodeAdapter.ts`、`src/session/SessionManager.ts`、`src/commands/handlers.ts`。

实现细节：`SessionManager` 保存当前运行任务的 `BackendSession` 和 stop 函数；`/stop` 在 `running` 时先回复 `已请求中断当前 Agent 任务。`，然后设置状态为 `stopping`；`ClaudeCodeAdapter.stop()` 调用 SDK 的中断能力；中断后继续 drain 当前响应流直到结束；最终发出 `AgentEvent.stopped` 或由 SessionManager 发送 `当前 Agent 任务已中断。`

实现细节：中断过程中拒绝新普通消息、`/cc`、`/close`；重复 `/stop` 回复 `正在中断，请稍等。`；中断失败时记录详细日志，回复简短错误，并尽量恢复到 `idle`。

验收：发起长任务后 `/stop` 能中断；中断后 `/state` 显示 `idle`；中断后可以继续发送普通消息；多次 `/stop` 不会导致状态错乱。

## T18 [TODO] 实现 Markdown 输出渲染和长消息分段

阶段：第一阶段，输出体验。

目标：保证 Claude Code 输出能稳定发送到钉钉，超长内容能拆分。

涉及文件：`src/output/OutputRenderer.ts`、`src/output/splitMarkdown.ts`、`src/output/formatErrors.ts`。

实现细节：`OutputRenderer.render(events, replySink)` 聚合 `AgentEvent.text` 和 `done.result`；如果输出为空，发送 `任务已完成，但没有文本输出。`；错误事件格式化为 `执行失败：...`；中断事件格式化为 `当前 Agent 任务已中断。`；按 `output.maxMessageChars` 分段发送 Markdown。

实现细节：分段优先按段落边界切分；如果包含代码块，尽量不要在三反引号内部切分；如果无法避免，分段时补齐代码块围栏或退化为普通文本提示。

验收：短输出单条发送；超过限制的长输出多条发送；代码块分段不明显破坏 Markdown；错误和中断有清晰提示。

## T19 [TODO] 安装并封装钉钉 Stream SDK

阶段：第一阶段，钉钉接入。

目标：创建 `DingTalkAdapter`，负责连接 Stream Mode 并注册机器人消息回调。

涉及文件：`src/dingtalk/DingTalkAdapter.ts`、`src/dingtalk/types.ts`、`src/dingtalk/mapMessage.ts`、`package.json`。

实现细节：安装官方钉钉 Stream SDK；`DingTalkAdapter.start()` 使用 `clientId` 和 `clientSecret` 建立连接；注册机器人消息 topic 的回调；回调中不要直接执行业务逻辑，只把 raw callback 映射为内部 `IncomingMessage` 并交给注入的 handler。

实现细节：第一批真实消息需要 debug 记录 raw 字段样本，但必须脱敏；重点确认 `messageId`、`senderId`、私聊类型字段、文本字段、可回复上下文字段；字段映射集中放在 `mapMessage.ts`，不要散落在业务代码中。

验收：服务能连接钉钉 Stream Mode；收到私聊文本时日志显示已映射为 `IncomingMessage`；字段缺失时记录 warn 而不是崩溃。

## T20 [TODO] 实现 SecurityGate 私聊和单用户校验

阶段：第一阶段，钉钉安全。

目标：确保只有指定用户的私聊消息能进入命令和 Agent 处理。

涉及文件：`src/security/SecurityGate.ts`、`src/dingtalk/DingTalkAdapter.ts`、`src/app.ts`。

实现细节：`SecurityGate.authorize(message)` 检查 `conversationType === "private"`；如果 `rejectGroupMessages` 为 true，群聊直接返回拒绝；检查 `senderId` 是否在 `config.dingtalk.allowedUserIds`；拒绝时只记录日志，不回复用户；空文本消息第一阶段可回复给授权用户 `暂不支持该消息类型` 或直接忽略。

实现细节：安全校验必须发生在 `CommandRouter` 和后端调用之前；未授权消息不能触发 `/state`、`/cc`、`/stop` 等任何逻辑。

验收：授权用户私聊 `/state` 有响应；未授权用户无响应且日志有 warn；群聊消息无响应且不触发状态变化。

## T21 [TODO] 实现钉钉 Text 和 Markdown 回复

阶段：第一阶段，钉钉输出。

目标：让 `ReplySink` 能通过钉钉把文本和 Markdown 发回当前私聊。

涉及文件：`src/dingtalk/DingTalkReplySink.ts`、`src/dingtalk/DingTalkAdapter.ts`、`src/dingtalk/types.ts`。

实现细节：基于钉钉机器人消息上下文实现 `sendText` 和 `sendMarkdown`；优先使用 SDK 提供的回复接口或 `sessionWebhook`；如果 `sessionWebhook` 过期或不存在，返回可记录的错误；第一阶段只要求回复收到的私聊消息，不要求主动推送历史会话。

实现细节：Markdown 标题和代码块需要兼容钉钉 Markdown 子集；发送失败时要记录 HTTP 状态、错误码和安全摘要，不打印 token。

验收：授权用户私聊 `/state` 能收到 Markdown 状态；普通消息完成后能收到 Claude Code 回复；发送失败不会导致进程退出。

## T22 [TODO] 组装真实 App 启动流程

阶段：第一阶段，端到端集成。

目标：把配置、状态、命令、SessionManager、Claude 后端、输出渲染和钉钉适配器串起来。

涉及文件：`src/app.ts`、`src/index.ts`。

实现细节：`startApp()` 加载配置，创建 logger、PathPolicy、StateStore、SessionManager、BackendRegistry、ClaudeCodeAdapter、OutputRenderer、CommandRouter、SecurityGate、DingTalkAdapter；注入统一 `handleIncomingMessage`；启动 DingTalkAdapter；进程退出时尽量 close 当前 backend client 和 Stream client。

实现细节：所有消息处理入口都要 try/catch；用户可见错误通过 ReplySink 回复；内部错误写日志；状态恢复必须放在 finally 或集中错误处理里。

验收：运行 `npm run dev` 后真实钉钉私聊 `/state` 可用；普通消息可返回 Claude Code 回复；异常不会导致进程退出。

## T23 [TODO] 增加消息去重和 Stream 重连处理

阶段：第一阶段，加固。

目标：避免钉钉重复投递导致重复执行，并提高长时间运行稳定性。

涉及文件：`src/dingtalk/MessageDeduper.ts`、`src/dingtalk/DingTalkAdapter.ts`、`src/app.ts`。

实现细节：`MessageDeduper` 基于 `message.id` 维护最近 5 分钟已处理集合；重复消息直接忽略；集合要定期清理，避免无限增长；如果 message ID 缺失，用 senderId、text、时间窗口生成弱 key 并记录 warn。

实现细节：Stream SDK 如果暴露断线事件，记录并指数退避重连；如果 SDK 自带 `start_forever` 或等价机制，也要记录连接状态；连接失败时错误日志必须包含可操作原因，例如凭证错误或网络错误。

验收：同一 message ID 重复进入不会重复触发 Agent；Stream 断线时有明确日志；重连后仍能处理私聊消息。

## T24 [TODO] 完成第一阶段 README 和运行说明

阶段：第一阶段，文档。

目标：让后续 coding agent 或用户不需要重新查钉钉创建流程和运行命令。

涉及文件：`README.md` 或 `docs/getting-started.md`。

实现细节：文档包含钉钉测试组织/企业内部应用/机器人/Stream Mode 创建步骤摘要；说明如何复制配置样例；说明如何获取或确认 `allowedUserIds`，可以通过首次 debug 日志确认；说明运行命令；说明第一阶段支持的命令 `/cc`、`/close`、`/state`、`/stop`、`/oc` 占位；说明 OpenCode、`/dl`、卡片流式输出还未支持。

实现细节：文档必须强调配置文件和状态文件不应提交；说明只支持私聊和单用户；说明本地 Agent 可能操作文件，应谨慎配置 `allowedRootDirs` 和 Claude 权限。

验收：按 README 从空配置开始能完成本地启动；文档中的命令与实际 `package.json` 脚本一致。

## T25 [TODO] 执行第一阶段端到端验收和修复

阶段：第一阶段，发布前验收。

目标：按 `PLAN.md` 的第一阶段验收清单完整验证，并修复发现的问题。

涉及文件：可能涉及所有第一阶段实现文件；新增 `docs/phase1-acceptance.md` 可选。

实现细节：逐项验证服务启动、授权私聊 `/state`、默认环境普通消息、`/cc` 项目切换、项目上下文读取、`/close` 回默认环境、运行中普通消息拒绝、`/stop` 中断、未授权用户拒绝、群聊拒绝、服务重启恢复。

实现细节：记录每项验收结果；发现 bug 时修复并重新跑相关项；如果某项因为外部钉钉配置无法验证，写明阻塞原因和需要的外部操作。

验收：第一阶段验收清单全部通过，或只剩明确外部阻塞项；`TODO.md` 中 T01 到 T25 状态按实际完成情况更新。

## T26 [TODO] 第二阶段接入 OpenCode SDK 和 OpenCodeAdapter

阶段：第二阶段，OpenCode 后端。

目标：在现有 `BackendAdapter` 抽象下增加 OpenCode 支持。

涉及文件：`src/backend/opencode/OpenCodeAdapter.ts`、`src/backend/opencode/types.ts`、`src/backend/BackendRegistry.ts`、`package.json`。

实现细节：安装 `@opencode-ai/sdk`；决定运行模式，优先使用 SDK 的 `createOpencode` 自动启动 server，除非需要手动管理 `opencode serve`；`OpenCodeAdapter.open` 为每个项目目录创建或复用 OpenCode server/client/session；维护 `cwd -> { serverUrl, sessionId }` 映射；`send` 调用 OpenCode session prompt；监听 OpenCode event stream，把 `message.part.updated` 中的 text delta 映射为 `AgentEvent.text`，把 `session.idle` 映射为完成，`session.error` 映射为错误。

实现细节：`stop` 对应 OpenCode session abort；`close` 可只释放本进程创建的 OpenCode server，不要删除用户会话数据；所有 OpenCode 事件映射集中在一个文件，避免后续版本变化时散落修改。

验收：本地 fake 输入可以直接调用 OpenCodeAdapter；OpenCode 能在指定 `cwd` 回答问题；错误时不会影响 Claude Code 后端。

## T27 [TODO] 第二阶段实现 `/oc <dir>` 项目切换

阶段：第二阶段，OpenCode 命令。

目标：允许用户通过 `/oc` 打开或切换 OpenCode 项目，并与 `/cc` 共存。

涉及文件：`src/commands/handlers.ts`、`src/session/SessionManager.ts`、`src/state/types.ts`、`src/config/types.ts`、`src/backend/BackendRegistry.ts`。

实现细节：把 `backend` 类型扩展为 `"claude-code" | "opencode"`；`/oc <dir>` 复用 `/cc` 的路径展开、realpath 和 `allowedRootDirs` 校验；状态必须为 `idle` 才能切换；`activeProject.backend` 保存为 `opencode`；`knownProjects` 需要按 `cwd + backend` 或结构化 key 保存，避免同一目录下 Claude Code 和 OpenCode session 混淆。

实现细节：`/state` 显示当前后端为 `OpenCode` 或 `Claude Code`；`/close` 对两种后端都回默认环境；`/stop` 根据当前后端调用对应 adapter。

验收：`/cc <dir>` 和 `/oc <dir>` 可以互相切换；普通消息进入当前后端；`/state` 显示正确后端；`/stop` 对 OpenCode 生效。

## T28 [TODO] 第二阶段实现 `/dl <path>` 本地文件发送

阶段：第二阶段，文件发送。

目标：允许授权用户通过钉钉私聊从本地电脑发送白名单目录内的文件。

涉及文件：`src/files/FileService.ts`、`src/commands/handlers.ts`、`src/config/types.ts`、`src/config/schema.ts`、`src/dingtalk/DingTalkReplySink.ts`、`src/security/PathPolicy.ts`。

实现细节：扩展配置 `security.downloadAllowedDirs` 和 `security.maxDownloadFileBytes`；`/dl <path>` 支持绝对路径、`~`、相对路径；相对路径基于当前环境 `cwd`；执行 `realpath` 后校验在 `downloadAllowedDirs` 内；校验目标是普通文件且大小不超过限制；拒绝目录、设备文件、socket、软链逃逸和超大文件。

实现细节：通过钉钉上传媒体或文件接口上传，再发送文件消息到当前私聊；如果钉钉文件接口需要 access token，则实现 token 获取和缓存；记录审计日志，包含 senderId、文件 realpath、大小、时间、发送结果；不要在错误回复中泄露不必要的完整路径，可只显示 basename。

验收：`/dl README.md` 能发送当前项目文件；不在白名单内的文件被拒绝；超大文件被拒绝；软链指向白名单外时被拒绝；发送失败有明确用户提示。

## T29 [TODO] 第二阶段实现用户附件输入

阶段：第二阶段，附件输入。

目标：用户向机器人发送图片或文件时，服务端下载并作为 Agent 输入的一部分。

涉及文件：`src/dingtalk/mapMessage.ts`、`src/dingtalk/media.ts`、`src/files/TempFileStore.ts`、`src/messages/types.ts`、`src/backend/types.ts`、`src/backend/claude/ClaudeCodeAdapter.ts`、`src/backend/opencode/OpenCodeAdapter.ts`。

实现细节：扩展 `IncomingMessage`，增加 `attachments`，包含 `type`、`filename?`、`mime?`、`downloadCode?`、`localPath?`、`size?`；识别钉钉图片、文件消息类型；通过钉钉媒体接口下载到受控临时目录；限制附件大小和类型；临时目录建议为 `.agent-dingtalk-tmp/` 并加入 `.gitignore`。

实现细节：Claude Code 后端如果支持附件输入则按 SDK 推荐方式传递；如果暂不支持，先把本地路径和文件摘要追加到 prompt；OpenCode 后端同理；任务结束后可以保留短时间用于 agent 读取，再由清理任务删除。

验收：用户发送文本文件后 Agent 能读取或知道本地路径；用户发送图片后 Agent 能看到图片或图片路径；不支持类型有清晰提示；临时目录定期清理，不会无限增长。

## T30 [TODO] 第二阶段实现钉钉卡片或 AI Card 流式输出

阶段：第二阶段，流式体验。

目标：用钉钉互动卡片或 AI Card 模拟 Claude Code/OpenCode 的文字流式输出效果。

涉及文件：`src/dingtalk/cards/CardClient.ts`、`src/output/CardStreamingRenderer.ts`、`src/config/types.ts`、`src/config/schema.ts`、`src/output/OutputRenderer.ts`。

实现细节：先确认使用新版卡片还是 AI Card，不再依赖历史普通版接口；扩展配置 `streaming.mode`、`streaming.templateId`、`streaming.updateThrottleMs`、`streaming.fallbackMode`；任务开始时创建卡片；聚合 `AgentEvent.text`；每 `updateThrottleMs` 更新一次卡片内容；完成时更新最终状态；中断时显示已中断；错误时显示失败摘要。

实现细节：卡片创建或更新失败时降级为 Markdown 完整回复；记录 card ID、任务 ID 和会话 ID 的映射；更新节流默认建议 `800ms`；不要每个 token 更新一次卡片。

验收：长回复能以卡片持续更新；卡片更新失败时最终回复不丢失；`/stop` 后卡片显示已中断；频繁输出不会明显触发限流。

## T31 [TODO] 第二阶段增强工具进度展示

阶段：第二阶段，输出体验。

目标：把 Claude Code 和 OpenCode 的工具调用进度以可读形式展示给用户。

涉及文件：`src/backend/claude/ClaudeCodeAdapter.ts`、`src/backend/opencode/OpenCodeAdapter.ts`、`src/output/ToolProgressRenderer.ts`、`src/config/types.ts`。

实现细节：扩展配置 `output.toolProgress`，可取 `off`、`brief`、`all`；Claude Code 侧将工具开始、完成、错误映射为 `tool_start`、`tool_finish`、`error`；OpenCode 侧将 tool part 状态映射为相同事件；`brief` 模式只显示工具名和状态，`all` 模式可以显示摘要但不能泄露敏感参数。

实现细节：默认 `off` 或 `brief`，避免刷屏；卡片流式模式下工具进度可以显示在卡片底部；Markdown 模式下可以在最终回复前追加简短进度摘要。

验收：工具调用开始和结束能在日志中看到；开启 `brief` 后用户能看到简短进度；关闭后不影响正常回复。

## T32 [TODO] 增加自动化测试和 smoke test

阶段：横跨第一阶段和第二阶段，质量保障。

目标：为配置、路径策略、命令解析、状态机、输出分段和后端事件映射增加可重复测试。

涉及文件：`tests/`、`vitest.config.ts` 或等价测试配置、`package.json`。

实现细节：引入 Vitest 或项目选定测试框架；测试 `loadConfig` 的默认值和错误路径；测试 `PathPolicy` 的白名单、`..`、软链场景；测试 `parseCommand`；测试 `SessionManager` 状态流转；测试 `OutputRenderer` 长 Markdown 分段；测试 FakeBackend 完整消息路由；第二阶段补充 OpenCode event 映射和 `/dl` 路径校验。

实现细节：增加 `npm test`；增加一个不依赖真实钉钉和真实 Claude Code 的 CI 级测试集合；真实钉钉和真实 Claude Code 只做手工 smoke test，不放入默认自动测试。

验收：`npm test` 稳定通过；核心状态机修改时有测试保护；fake 集成测试能覆盖 `/cc`、普通消息、`/stop`、`/close` 的基本流程。

## T33 [TODO] 第二阶段端到端验收和文档更新

阶段：第二阶段，发布前验收。

目标：验证 OpenCode、`/dl`、附件输入和卡片流式输出，并更新用户文档。

涉及文件：`README.md`、`docs/dingtalk-agent-design.md`、`PLAN.md`、`TODO.md`、可选 `docs/phase2-acceptance.md`。

实现细节：验证 `/oc <dir>`、`/cc <dir>` 互相切换；验证 `/stop` 对两种后端均生效；验证 `/dl` 安全限制；验证图片/文件输入；验证卡片流式输出和降级；把实际钉钉卡片配置步骤补充到文档；更新功能状态表，标明第一阶段和第二阶段已支持内容。

验收：第二阶段新增能力均有手工验收记录；文档与实际命令一致；`TODO.md` 中第二阶段任务状态按实际执行结果更新。
