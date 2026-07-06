# 第一阶段端到端验收记录

日期：2026-07-06  
任务：T25 执行第一阶段端到端验收和修复

## 验证结论

第一阶段本地可验证路径均通过；未发现需要修改运行代码的缺陷。真实钉钉 Stream Mode 私聊闭环依赖外部企业内部应用、机器人、Stream Mode 凭据和授权用户，当前环境没有这些外部资源，因此真实钉钉收发只保留为明确外部阻塞项。

## 已执行验证

| 验证项 | 结果 | 记录 |
| --- | --- | --- |
| TypeScript 类型检查 | 通过 | `npm run typecheck` |
| 编译 | 通过 | `npm run build` |
| 本地命令闭环 | 通过 | `npm run fake:message -- "/state" "/cc ." "hello fake backend" "/close"` |
| 未授权用户拒绝 | 通过 | `npm run fake:message -- --sender unauthorized-user "/state"`，无回复且记录 warn |
| 群聊拒绝 | 通过 | `npm run fake:message -- --conversation-type group "/state"`，无回复且记录 warn |
| 状态持久化和重启恢复 | 通过 | 复用临时 state 文件后，`/state` 恢复 active project 和 fake session，runtime 为 `idle` |
| 服务启动和关闭 | 通过 | 使用临时配置、临时状态文件和 fake DingTalk Stream client 验证 `startApp()` 注册 topic、connect、close/disconnect |
| 钉钉消息映射和回复 payload | 通过 | 使用 fake callback 验证私聊 text 映射、`senderStaffId` 提取、Text/Markdown webhook payload |
| 运行中并发规则和 `/stop` | 通过 | 使用 one-shot long-running fake backend 验证普通消息拒绝、`/cc` 拒绝、`/state` 可用、`/stop` 后回到 `idle` 且可继续普通消息 |
| Claude Code adapter smoke | 通过 | `npm run claude:prompt -- --max-turns 1 --cwd . "请只回复：OK"` 返回 `OK` 和 session ID |
| Claude Code 项目上下文 | 通过 | 使用临时非敏感目录和 `acceptance.txt`，`--cwd <tmpdir> --tool Read` 能读取并回复文件内容 |
| Claude Code 中断映射 | 通过 | 使用 fake SDK query 验证 `adapter.stop()` 调用 `interrupt()`，并映射为 `AgentEvent.stopped` |

## PLAN 第一阶段验收清单

| 清单项 | 结果 | 说明 |
| --- | --- | --- |
| 服务启动后连接钉钉 Stream Mode | 本地通过；真实钉钉外部阻塞 | fake Stream client 验证注册和连接；真实连接需要外部 DingTalk 凭据 |
| 指定用户私聊 `/state` 有响应 | 本地通过；真实钉钉外部阻塞 | fake 私聊路由和 DingTalk Markdown payload 通过 |
| 指定用户普通消息进入默认环境并返回 Claude Code 结果 | 通过 | fake 路由通过；Claude Code adapter smoke 通过 |
| `/cc ~/repos/foo` 能切换到项目目录 | 通过 | `/cc .` 经 realpath/allowedRootDirs 校验后切换项目 |
| 项目目录中的普通消息能读到该项目文件上下文 | 通过 | 临时非敏感项目目录中 Claude Code 可读取 `acceptance.txt` |
| `/close` 后回到默认环境 | 通过 | fake command flow 返回默认环境 |
| 长任务运行中普通消息被拒绝并提示 `/stop` | 通过 | one-shot fake backend 并发检查通过 |
| 长任务运行中 `/stop` 能中断当前任务 | 通过 | one-shot fake backend 和 Claude fake query 中断映射均通过 |
| 中断后能继续发送新任务 | 通过 | `/stop` 完成后新普通消息进入 backend |
| 未授权用户不会触发处理 | 通过 | security gate 拒绝且无回复 |
| 群聊消息不会触发处理 | 通过 | security gate 拒绝且无回复 |
| 服务重启后能恢复 active project 和已知 session | 通过 | 临时 state 文件复用后恢复 active project/session，runtime 重置为 `idle` |

## 外部阻塞项

真实钉钉私聊收发未在当前环境执行。完成真实验收需要：

1. 准备企业内部应用、机器人和 Stream Mode，并配置真实 `clientId`、`clientSecret`、`robotCode`。
2. 用授权用户 ID 填写 `dingtalk.allowedUserIds`。
3. 运行 `npm run dev`，向机器人私聊发送 `/state`、普通消息、`/cc <dir>`、`/close`，并在长任务期间发送 `/stop`。
4. 确认未授权用户和群聊不会触发命令或 Agent。
