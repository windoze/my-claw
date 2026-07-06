# 部署指南（DEPLOYMENT）

本文档说明如何在真实环境中部署并长期运行 **my-claw**（钉钉私聊 Agent 网关）。

my-claw 运行在你本地/自有机器上，通过钉钉 **Stream 模式（长连接）** 接收指定用户的私聊消息，
转发给本机的 **Claude Code** 或 **OpenCode** 后端执行，再把结果回复到钉钉。
由于使用长连接、不暴露公网 HTTP 端口，**不需要公网 IP、域名或反向代理**。

> 钉钉开放平台后台的准备工作（创建应用、机器人、权限、卡片模板等）请见
> [`docs/dingtalk-setup-guide.md`](docs/dingtalk-setup-guide.md)。本文只覆盖机器侧的部署运行。

---

## 1. 环境要求

| 组件 | 要求 | 说明 |
|---|---|---|
| 操作系统 | macOS / Linux | 需要能保持进程长期运行（长连接） |
| Node.js | ≥ 20（建议 LTS） | 项目使用 ESM；`@types/node` 为 24.x |
| npm | 随 Node 附带 | 用于安装依赖与运行脚本 |
| 网络 | 可访问 `*.dingtalk.com` | Stream 长连接 + OpenAPI 调用 |
| 后端（二选一或都装） | Claude Code / OpenCode | 见下方后端依赖 |

### 后端依赖

- **Claude Code 后端**：需要本机已配置好 `@anthropic-ai/claude-agent-sdk` 的认证
  （Claude Code / Agent SDK 登录状态可用）。
- **OpenCode 后端**：需要本机已安装并登录 `opencode`；模型使用 `provider/model` 或
  `provider:model` 格式。

至少要保证你在配置里选用的默认后端可用。

---

## 2. 获取代码与安装依赖

```sh
git clone <本仓库地址> my-claw
cd my-claw
npm install
```

---

## 3. 准备配置文件

```sh
cp agent-dingtalk.config.example.jsonc agent-dingtalk.config.jsonc
```

编辑 `agent-dingtalk.config.jsonc`，至少填写：

- `dingtalk.clientId` / `dingtalk.clientSecret`：钉钉应用凭证
- `dingtalk.robotCode`：机器人编码（AI Card 必填，建议始终填写）
- `dingtalk.allowedUserIds`：白名单用户 ID（获取方式见下方"首次启动"）
- `defaultEnvironment.backend`：`claude-code` 或 `opencode`
- `defaultEnvironment.cwd`：Agent 默认工作目录
- `security.allowedRootDirs` / `security.downloadAllowedDirs`：限制 Agent 可访问 / 可发送文件的目录

> 各字段的完整含义见 `README.md` 的"本地配置"一节；钉钉字段与后台概念的对照见
> `docs/dingtalk-setup-guide.md`。

配置文件默认从仓库根目录的 `agent-dingtalk.config.jsonc` 读取，也可用环境变量指定其他路径：

```sh
AGENT_DINGTALK_CONFIG=/absolute/path/to/agent-dingtalk.config.jsonc npm start
```

> ⚠️ `agent-dingtalk.config.jsonc`、`.agent-dingtalk-state.json*`、`.agent-dingtalk-tmp/`
> 均已在 `.gitignore` 中，**必须保持不提交**。

---

## 4. 部署前自检（可选但推荐）

在连接钉钉之前，先本地验证组件是否就绪：

```sh
# 1) 类型检查
npm run typecheck

# 2) 不连钉钉/后端，验证命令路由
npm run fake:message -- "/state" "/cc ." "hello" "/close"

# 3) 不连钉钉，冒烟测试所选后端（按需二选一）
npm run claude:prompt -- --max-turns 1 --cwd . "请只回复：OK"
npm run opencode:prompt -- --cwd . "请只回复：OK"
```

---

## 5. 构建与启动

### 方式 A：编译后运行（推荐用于长期部署）

```sh
npm run build     # 编译到 dist/
npm start         # 运行 node dist/index.js
```

### 方式 B：直接用 tsx 运行（开发/调试）

```sh
npm run dev       # tsx src/index.ts
```

启动后，服务会连接钉钉 Stream Mode 并输出连接状态日志。
若配置缺失、字段错误、默认目录不存在或不在 `allowedRootDirs` 内，服务会在启动时报明确错误并退出。

### 首次启动：获取白名单用户 ID

1. 先填好 `clientId` / `clientSecret` 等并启动服务（此时 `allowedUserIds` 可能还没填对）。
2. 用**目标用户**私聊机器人发送任意一条文本。
3. 从服务端日志的脱敏 callback debug 样本里，读取 `senderStaffId`（或 `senderId`）。
4. 把该用户 ID 填入 `dingtalk.allowedUserIds`，**重启服务**。

---

## 6. 长期运行（进程守护）

服务依赖长连接，需要进程常驻。可任选一种守护方式：

### 使用 pm2

```sh
npm run build
pm2 start dist/index.js --name my-claw
pm2 save        # 保存进程列表
pm2 startup     # 生成开机自启脚本（按提示执行）
pm2 logs my-claw
```

> 若需指定配置路径：
> `AGENT_DINGTALK_CONFIG=/abs/path/config.jsonc pm2 start dist/index.js --name my-claw`

### 使用 systemd（Linux）

创建 `/etc/systemd/system/my-claw.service`：

```ini
[Unit]
Description=my-claw DingTalk Agent Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/my-claw
ExecStart=/usr/bin/node dist/index.js
Environment=AGENT_DINGTALK_CONFIG=/opt/my-claw/agent-dingtalk.config.jsonc
Restart=always
RestartSec=5
User=youruser

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now my-claw
sudo journalctl -u my-claw -f
```

### 使用 launchd（macOS）

可用 `launchctl` 加载一个 `~/Library/LaunchAgents/com.my-claw.plist`，
`ProgramArguments` 指向 `node /path/to/dist/index.js`，并设置 `KeepAlive=true`、
`WorkingDirectory` 与 `EnvironmentVariables`。

---

## 7. 状态文件与数据

运行期间服务会在工作目录生成：

| 文件/目录 | 用途 |
|---|---|
| `.agent-dingtalk-state.json`（及 `.tmp`） | 持久化 active project、已知项目、Claude Code session ID |
| `.agent-dingtalk-tmp/` | 用户上传附件下载后的受控临时目录 |

- 重启后会从状态文件恢复 active project / session，无需手动干预。
- 这些文件包含运行上下文，**不要提交 Git**（已在 `.gitignore` 中）。
- 备份时如包含状态文件，注意其中的目录路径等信息。

---

## 8. 升级与回滚

```sh
git pull
npm install        # 依赖有变化时
npm run build
# 重启守护进程，例如：
pm2 restart my-claw          # 或 systemctl restart my-claw
```

- 升级前建议备份 `agent-dingtalk.config.jsonc` 与状态文件。
- 若钉钉应用权限或 Stream 配置有调整，记得在钉钉后台**重新发布应用版本**。

---

## 9. 部署检查清单

- [ ] Node.js ≥ 20 已安装
- [ ] 所选后端（Claude Code / OpenCode）已在本机认证可用
- [ ] `npm install` 成功
- [ ] `agent-dingtalk.config.jsonc` 已填写（clientId / clientSecret / robotCode / 后端 / 目录白名单）
- [ ] `npm run typecheck` 与 `fake:message` 自检通过
- [ ] `npm run build` 成功
- [ ] 首次启动并通过私聊日志获取到 `allowedUserIds`，已回填并重启
- [ ] 已配置进程守护（pm2 / systemd / launchd）与开机自启
- [ ] 确认配置与状态文件均未提交 Git

---

## 10. 运维排查

若机器人无回复或后端异常，按以下顺序排查（详见 `README.md` 安全与运维一节）：

1. 消息是否为**私聊**（群聊默认被拒绝）。
2. 发送者 userId 是否在 `allowedUserIds` 中。
3. Stream 长连接是否建立成功（看启动日志）。
4. 回调 `sessionWebhook` 是否存在或已过期。
5. AI Card：模板是否已发布、`robotCode` 是否有效、`templateId`/`contentKey` 是否正确（否则降级 Markdown）。
6. Claude Code 失败：检查 Agent SDK 认证、`cwd` 是否存在且在白名单、工具权限与 `maxTurns`。
7. OpenCode 失败：检查 `opencode` 安装与认证、`model` 是否为 `provider/model` 或 `provider:model` 格式。
