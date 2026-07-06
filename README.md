# my-claw

钉钉私聊 Agent 网关。把指定钉钉用户的私聊消息转给本机 Claude Code 或 OpenCode 后端，并把结果以钉钉 Text/Markdown 回复返回。

## 当前阶段能力

- 仅支持钉钉私聊和配置中的单用户白名单；未授权用户和群聊不会触发命令或 Agent。
- 默认后端可配置为 Claude Code 或 OpenCode，支持默认工作目录、`/cc <dir>` Claude Code 项目目录切换和 `/oc <dir>` OpenCode 项目目录切换。
- 支持运行状态持久化、Claude Code session ID 保存/恢复、消息去重、Stream 连接状态日志、`/stop` 中断、`/dl <path>` 白名单本地文件发送、用户图片/文件附件输入和长 Markdown 分段。
- 钉钉卡片/AI Card 流式输出仍未支持。

## 准备钉钉 Stream Mode

1. 使用个人测试组织，或在企业组织中取得企业内部应用开发权限。
2. 创建企业内部应用，添加机器人能力。
3. 在机器人消息接收模式中选择 Stream Mode，并发布应用版本。
4. 记录应用的 `clientId`、`clientSecret`，以及机器人需要时使用的 `robotCode`。
5. 首次启动服务后，用目标用户私聊机器人发送一条文本消息；服务会输出脱敏的 callback debug 样本，可从其中的 `senderStaffId` 或 `senderId` 确认要写入 `dingtalk.allowedUserIds` 的用户 ID。

不要把 `clientSecret`、真实配置文件或日志中的敏感片段提交到 Git。

## 本地配置

安装依赖并复制配置样例：

```sh
npm install
cp agent-dingtalk.config.example.jsonc agent-dingtalk.config.jsonc
```

编辑 `agent-dingtalk.config.jsonc`：

- `dingtalk.clientId`、`dingtalk.clientSecret`、`dingtalk.robotCode`：填入钉钉应用和机器人信息。
- `dingtalk.allowedUserIds`：只填允许使用该 Agent 的钉钉用户 ID。
- `dingtalk.rejectGroupMessages`：第一阶段建议保持 `true`。
- `defaultEnvironment.backend`：无 active project 时使用的后端，可为 `claude-code` 或 `opencode`。
- `defaultEnvironment.cwd`：无 active project 时 Agent 运行的默认目录。
- `security.allowedRootDirs`：允许 `/cc` 和 `/oc` 打开的目录根；所有目录会经过 `realpath` 校验，软链逃逸会被拒绝。
- `security.downloadAllowedDirs`：允许 `/dl` 发送文件的目录根；未配置时默认复用 `allowedRootDirs`，文件会经过 `realpath` 校验以拒绝软链逃逸。
- `security.maxDownloadFileBytes`：`/dl` 单文件大小上限，默认 20 MiB。
- `security.attachmentTempDir`：用户发送图片或文件后保存到本机的受控临时目录，默认 `.agent-dingtalk-tmp`。
- `security.maxAttachmentFileBytes`：用户附件输入单文件大小上限，默认 20 MiB。
- `security.allowedAttachmentMimeTypes`：允许作为 Agent 输入的附件 MIME 类型；默认允许常见文本、JSON、PDF 和图片类型。
- `claudeCode.permissionMode`、`claudeCode.allowedTools`、`claudeCode.maxTurns`：按本机安全边界配置 Claude Code 权限和轮数。
- OpenCode 使用本机 `opencode` 认证状态；如需指定模型，`model` 使用 OpenCode SDK 的 `provider/model` 或 `provider:model` 格式。
- `output.maxMessageChars`：单条钉钉 Markdown 回复的最大字符数，超出后会自动分段。

默认配置路径是仓库根目录的 `agent-dingtalk.config.jsonc`。也可以用环境变量指定：

```sh
AGENT_DINGTALK_CONFIG=/absolute/path/to/agent-dingtalk.config.jsonc npm run dev
```

`agent-dingtalk.config.jsonc`、`.agent-dingtalk-state.json`、`.agent-dingtalk-state.json.tmp` 和 `.agent-dingtalk-tmp/` 已在 `.gitignore` 中，必须保持不提交。状态文件会保存 active project、已知项目和 session ID。

## 运行命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 以 `tsx src/index.ts` 启动开发服务并连接钉钉 Stream Mode。 |
| `npm run typecheck` | 执行 TypeScript 类型检查。 |
| `npm run build` | 编译到 `dist/`。 |
| `npm start` | 运行已编译的 `dist/index.js`，需先执行 `npm run build`。 |
| `npm run fake:message -- "/state" "/cc ." "hello" "/close"` | 不连接钉钉和 Claude Code，用 fake 组件验证命令和本地路由。 |
| `npm run claude:prompt -- --max-turns 1 --cwd . "请只回复：OK"` | 不连接钉钉，直接 smoke test Claude Code adapter。 |
| `npm run opencode:prompt -- --cwd . "请只回复：OK"` | 不连接钉钉，直接 smoke test OpenCode adapter。 |

从空配置启动时，先完成 `npm install`、复制并填写配置，再运行：

```sh
npm run dev
```

配置缺失、字段错误、默认目录不存在或不在 `allowedRootDirs` 内时，服务会在启动时输出明确错误。

## 钉钉私聊命令

| 命令 | 说明 |
| --- | --- |
| `/state` | 查看脱敏后的运行状态、当前环境和 session 摘要。 |
| `/cc <dir>` | 切换到允许目录内的 Claude Code 项目；路径包含空格时使用引号，例如 `/cc "/Users/me/My Repo"`。 |
| `/close` | 关闭当前 active project，回到默认环境，并保留项目 session 记录。 |
| `/stop` | 当前任务运行中请求中断；空闲时会提示没有任务。 |
| `/oc <dir>` | 切换到允许目录内的 OpenCode 项目；路径包含空格时使用引号，例如 `/oc "/Users/me/My Repo"`。 |
| `/dl <path>` | 发送允许目录内的本地普通文件；相对路径基于当前环境 `cwd`，路径包含空格时使用引号，例如 `/dl "docs/report.pdf"`。 |

非 slash 文本消息会发送给当前环境的 Claude Code 或 OpenCode。用户发送受支持的图片或文件时，服务会通过钉钉 `messageFiles.download` 接口下载到 `.agent-dingtalk-tmp/`，并把本地临时路径、文件名、MIME 和大小追加到 Agent prompt；当前后端未使用原生附件输入。任务运行中会拒绝新的普通消息和项目切换；可以发送 `/state` 查询状态，或发送 `/stop` 请求中断当前后端任务。

## 安全和运维注意事项

- 第一阶段只面向一个受信任用户的私聊工作流；不要把机器人加入可被多人触发的生产群聊。
- 本机 Agent 可能读取或修改文件。请谨慎设置 `security.allowedRootDirs`、`claudeCode.allowedTools` 和 `claudeCode.permissionMode`，不要把敏感目录纳入白名单。
- `/dl` 会直接读取并发送 `security.downloadAllowedDirs` 内的本地文件；请只把确实允许授权用户下载的目录加入该白名单。
- 用户上传附件会保存到 `security.attachmentTempDir`，默认按清理周期删除；请只允许确实需要交给 Agent 读取的 MIME 类型和大小范围。
- 日志会尽量脱敏 `clientSecret`、token、Authorization 等字段，但排查问题前仍应先检查日志内容再分享。
- 如果钉钉没有回复，优先检查：消息是否为私聊、`allowedUserIds` 是否匹配 debug 样本中的用户 ID、`sessionWebhook` 是否存在/过期、Stream 连接是否成功。
- 如果 Claude Code 调用失败，检查本机 Claude Code/Agent SDK 认证状态、`cwd` 是否存在并在白名单内、工具权限和 `maxTurns` 设置。
- 如果 OpenCode 调用失败，检查本机 `opencode` 安装和认证状态，以及 `model` 是否使用 `provider/model` 或 `provider:model` 格式。
