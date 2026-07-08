# 钉钉平台准备工作指南

> 本文档面向**在真实环境里运行或测试 my-claw 的人**，说明在正式启动服务之前，需要在
> [钉钉开放平台](https://open-dev.dingtalk.com/) 后台完成哪些准备工作，以及每一项如何对应到
> 本项目的配置文件 `agent-dingtalk.config.jsonc`。
>
> my-claw 是一个"钉钉私聊 Agent 网关"：它运行在你本地电脑上，通过钉钉 **Stream 模式（长连接）**
> 接收指定钉钉用户的**私聊消息**，转发给本机的 Claude Code / OpenCode 后端执行，再把结果回复到钉钉。
> 由于服务不暴露公网 HTTP，接入方式必须使用 Stream 模式，而不是 HTTP Webhook 回调。

---

## 1. 前置条件

| 条目 | 说明 |
|---|---|
| 钉钉组织 | 需要一个可用于开发的组织。可使用[个人测试企业/组织](https://open-dev.dingtalk.com/)，或在正式企业里获得企业内部应用的开发权限。 |
| 开发者权限 | 当前账号需要是该组织的**开发者**或**管理员**，才能创建应用、配置机器人、开通权限。 |
| 目标用户 | 明确谁会私聊这个机器人（本工具是单人工具，只服务白名单里的受信任用户）。 |

---

## 2. 创建企业内部应用

1. 登录[钉钉开放平台](https://open-dev.dingtalk.com/) → 「应用开发」→「企业内部应用」→ **创建应用**。
2. 记录应用凭证（后面填进配置文件）：
   - **Client ID（旧称 AppKey）** → 对应配置 `dingtalk.clientId`
   - **Client Secret（旧称 AppSecret）** → 对应配置 `dingtalk.clientSecret`

> ⚠️ Client Secret 是敏感凭证，切勿提交到 Git 或泄露给他人。

---

## 3. 添加并配置机器人

本项目使用**企业内部应用机器人**（不是群自定义机器人）。

1. 在应用内 →「应用能力」→ 添加**机器人**能力。
2. 机器人「消息接收模式」选择 **Stream 模式（Stream Mode / 长连接）**。
   - 这是关键：因为服务只在本地运行、不暴露公网地址，只能走长连接，不能用 HTTP 回调地址。
3. 记录机器人的 **RobotCode（机器人编码）** → 对应配置 `dingtalk.robotCode`。
   - 发送 AI 卡片、以及部分机器人接口需要它；建议始终填写。

---

## 4. 开通接口权限（Scope）

本项目实际调用了以下钉钉 OpenAPI，需要在应用「权限管理」中开通对应的权限点。
具体权限点名称以钉钉开放平台文档为准，按能力分类如下：

| 使用的能力 | 对应接口 | 何时需要 | 说明 |
|---|---|---|---|
| 获取企业 access_token | `GET /gettoken` | 始终 | 企业内部应用一般默认可用 |
| 机器人收发消息 | Stream 机器人回调 + 通过回调携带的 `sessionWebhook` 回复 | 始终 | 接收私聊消息、回复 text/markdown/file |
| 上传媒体文件 | `POST /media/upload` | 使用 `/dl` 发送本地文件时 | 需要「企业会话消息 / 媒体文件」相关权限 |
| 下载用户上传的附件 | `POST /v1.0/robot/messageFiles/download` | 用户向机器人发送图片/文件时 | 需要「机器人接收消息文件下载」相关权限 |
| 创建并投放 AI 卡片 | `POST /v1.0/card/instances/createAndDeliver` | 仅当 `streaming.mode = "ai-card"` | 需要互动卡片 / AI 卡片相关权限 |
| AI 卡片流式更新 | `PUT /v1.0/card/streaming` | 仅当 `streaming.mode = "ai-card"` | 同上 |

> 说明：如果你只用默认的 Markdown 输出模式，可以先不开通 AI 卡片相关权限；用到 `/dl` 发文件、
> 或接收用户附件时，再分别开通对应的媒体权限。

开通权限后，**记得发布/更新应用版本**，权限与 Stream 模式配置才会生效。

---

## 5.（可选）创建 AI 卡片模板

仅当你希望使用**流式卡片输出**（配置 `streaming.mode = "ai-card"`）时才需要。

1. 在钉钉[卡片平台](https://open-dev.dingtalk.com/)创建一个 **AI 卡片模板**并发布。
2. 记录完整模板 ID（cardTemplateId）→ 对应配置 `streaming.templateId`；不要填写模板名称、变量名或卡片标题。
3. 模板必须包含以下变量，否则卡片渲染/更新会失败：

| 变量名 | 用途 |
|---|---|
| `content`（或你自定义的 `streaming.contentKey`） | 承载正文，流式更新的内容写入这里 |

> 若卡片发送/更新失败，服务会自动降级为完整的 Markdown 回复（`streaming.fallbackMode = "markdown"`）。

---

## 6. 获取白名单用户 ID

本工具强制白名单：只有 `dingtalk.allowedUserIds` 里的用户能使用，其余一律拒绝，且默认拒绝群聊。

获取用户 ID 的步骤：
1. 先按第 7 节填好 `clientId` / `clientSecret` 等，启动服务。
2. 用**目标用户**私聊机器人发送任意一条文本消息。
3. 查看服务端日志中的脱敏样本，找到 `senderStaffId`（即该用户的 userId）。
4. 把这个 userId 填进 `dingtalk.allowedUserIds`，重启服务。

---

## 7. 填写本项目配置文件

配置文件默认路径为仓库根目录的 `agent-dingtalk.config.jsonc`
（可用环境变量 `AGENT_DINGTALK_CONFIG` 指定其他路径）。本项目**不使用 `.env`**，所有配置都在这个 JSONC 文件里。

从样例复制一份：

```bash
cp agent-dingtalk.config.example.jsonc agent-dingtalk.config.jsonc
```

需要**必须填写/替换**的钉钉相关字段：

```jsonc
{
  "dingtalk": {
    "clientId": "dingxxxxxxxxxxxxxxxx",                    // 必填：应用 Client ID / AppKey
    "clientSecret": "replace-with-dingtalk-client-secret", // 必填：应用 Client Secret / AppSecret
    "robotCode": "dingbotxxxxxxxx",                        // 建议填写；AI 卡片必填：机器人 RobotCode
    "allowedUserIds": ["replace-with-your-dingtalk-user-id"], // 必填：白名单用户 userId（见第 6 节）
    "rejectGroupMessages": true                            // 默认 true：拒绝群聊
  },

  // 以下仅当使用 AI 卡片流式输出时需要
  "streaming": {
    "mode": "markdown",                                    // 改为 "ai-card" 开启卡片流式
    "templateId": "replace-with-dingtalk-ai-card-template-id", // ai-card 模式必填：完整 cardTemplateId
    "contentKey": "content",                               // 需与卡片模板正文变量名一致
    "updateThrottleMs": 800,
    "fallbackMode": "markdown"
  }
}
```

### 配置字段 ↔ 钉钉后台概念对照表

| 配置字段 | 钉钉后台概念 | 从哪里获取 |
|---|---|---|
| `dingtalk.clientId` | 应用 **Client ID / AppKey** | 应用凭证页 |
| `dingtalk.clientSecret` | 应用 **Client Secret / AppSecret** | 应用凭证页 |
| `dingtalk.robotCode` | 机器人 **RobotCode** | 机器人配置页 |
| `dingtalk.allowedUserIds` | 目标钉钉用户 **userId** | 私聊回调日志中的 `senderStaffId`（见第 6 节） |
| `streaming.templateId` | **AI 卡片模板 ID（cardTemplateId）**，不是变量名或模板名称 | 卡片平台 |
| `streaming.contentKey` | AI 卡片模板正文变量名 | 卡片模板定义（默认 `content`） |

> 说明：本项目**不需要**配置 Corp ID、Agent ID 或固定 Webhook URL。
> 回复消息使用的是每条钉钉回调里携带的临时 `sessionWebhook`；access_token 用
> `clientId`/`clientSecret` 实时获取。

---

## 8. 准备工作检查清单

启动前逐项核对：

- [ ] 已创建企业内部应用，拿到 **Client ID** 和 **Client Secret**
- [ ] 已添加机器人能力，消息接收模式设为 **Stream 模式**
- [ ] 已记录机器人 **RobotCode**
- [ ] 已开通所需接口权限（至少：机器人收发；按需：媒体上传/下载、AI 卡片）
- [ ] （用 AI 卡片时）已创建并发布卡片模板，模板含 `content`，并记录完整 cardTemplateId
- [ ] **已发布 / 更新应用版本**，使权限与 Stream 配置生效
- [ ] 已复制并填写 `agent-dingtalk.config.jsonc`（clientId / clientSecret / robotCode）
- [ ] 已通过私聊 + 日志获取目标用户 userId，并填入 `allowedUserIds`

---

## 9. 常见排查

若机器人无回复，按顺序排查（详见 `README.md`）：

1. 是否为**私聊**（群聊默认被拒绝）。
2. 发送者 userId 是否在 `allowedUserIds` 白名单里。
3. Stream 长连接是否建立成功（看启动日志）。
4. 回调里的 `sessionWebhook` 是否存在或已过期。
5. 使用 AI 卡片时：模板是否已发布、`robotCode` 是否有效、`templateId` / `contentKey` 是否正确——否则会降级为 Markdown。

---

## 10. 安全注意事项

- `clientSecret`、真实配置文件 `agent-dingtalk.config.jsonc`、日志中的敏感片段**都不要提交 Git**
  （`.gitignore` 已忽略 `agent-dingtalk.config.jsonc`、`.agent-dingtalk-state.json*`、`.agent-dingtalk-tmp/`）。
- 严格控制 `allowedUserIds`，仅加入受信任的本人账号。
- 通过 `security.allowedRootDirs` / `security.downloadAllowedDirs` 限制 Agent 可访问和可发送文件的目录范围。
