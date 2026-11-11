# 自托管：全部使用自己的服务

这些配置在服务器启动时读取。`MIKKA_EDITION=community` 是默认版本；自己的邮箱、文件、密码箱、模型和订阅都不需要 Mikka 账号。主部署步骤见 [自托管部署](self-hosting.md)。

## 邮件

| 变量 | 用途 |
| --- | --- |
| `MIKKA_EMAIL_FROM` | 发件人，例如 `My Mikka <login@example.com>`。未设置时沿用 `Mikka <noreply@aspectlylabs.com>`；自行部署应配置自己有权发信的地址。 |
| `SMTP_URL` | SMTP 连接串，例如 `smtps://user:password@smtp.example.com:465`，或 `smtp://user:password@smtp.example.com:587?requireTLS=true`。用户名、密码中的特殊字符需 URL 编码。 |
| `RESEND_API_KEY` | 没有 `SMTP_URL` 时使用的 Resend Key。 |

SMTP 优先。验证邮箱、找回密码、账号数据导出通知和额度告警复用 `lib/mail-delivery.ts`，使用同一个发件人和传输配置。SMTP 的 provider acceptance（服务端接受邮件）与 Resend 的有效消息 ID 都是发送成功的条件。日志不记录收件人、正文、登录链接、SMTP 凭据或供应商错误正文。

本地可使用 Mailpit，例如 `SMTP_URL=smtp://mailpit:1025`。SMTP 是否需要 TLS 由自己的邮件服务决定；`smtps:` 从连接开始使用 TLS，`smtp:` 支持 STARTTLS。发信实现使用 [Nodemailer SMTP transport](https://nodemailer.com/smtp)。

## 文件与 S3 兼容存储

| 变量 | 用途 |
| --- | --- |
| `S3_ENDPOINT` | 服务根地址，例如 `http://minio:9000` 或自己的 S3 兼容 HTTPS 地址。支持路径前缀。 |
| `S3_BUCKET` | 已创建的私有 bucket。 |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | 对该 bucket 有读写权限的凭据。 |
| `S3_REGION` | 签名区域，默认 `us-east-1`；MinIO 可使用此默认值。 |

S3 配置优先于 R2。配置其中一部分却缺少必要字段时会拒绝写入，不会将文件悄悄写到另一个位置。上传、下载、删除、短期私有下载地址和大文件直传共用该配置；存储的数据库枚举仍叫 `r2`，以兼容现有记录和所有文件消费者。

原有 `R2_ACCOUNT_ID`（或 `CLOUDFLARE_ACCOUNT_ID`）、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_ARTIFACTS_BUCKET` 保持有效。R2 的默认 bucket 是 `mikka-artifacts`。

社区版未配置 bucket 时，即使 `NODE_ENV=production`，文件仍存储在自己的 PostgreSQL 中。云版的生产部署仍要求对象存储。数据库备份需包含内联文件；使用 bucket 时需同时备份 bucket。

## 密码箱

社区版设置 `CREDENTIAL_MASTER_KEY`，值为严格 base64 编码的 32 字节随机密钥。例如在自己的安全终端运行 `openssl rand -base64 32`，将结果放入服务器的 secret 配置。

每条秘密继续使用独立随机 AES-256-GCM 数据密钥。主密钥只包裹数据密钥；owner、credential ID、网站 origin 和用途绑定到 authenticated additional data。密码、会话快照和被包裹的数据密钥使用不同用途，跨用户、跨站点或篡改密文无法解密。不要把此密钥提交进仓库；恢复备份需要原密钥，更换密钥需要先迁移既有记录。

社区版在同一进程调用现有 broker：一次性租约、浏览器页面绑定、权限检查、截图保护和审计保持有效，不需要部署 `services/credential-broker`。云版继续使用独立 broker、AWS KMS 和 Vercel OIDC；即使意外设置本地主密钥，`MIKKA_EDITION=cloud` 也不会改用它。

## 管理员配置的默认模型

| 变量 | 用途 |
| --- | --- |
| `MIKKA_DEFAULT_MODEL_BASE_URL` | OpenAI-compatible Chat Completions API 根地址，例如 `https://models.example.com/v1`。 |
| `MIKKA_DEFAULT_MODEL_API_KEY` | 自己的提供方 API Key。 |
| `MIKKA_DEFAULT_MODEL_ID` | 提供方实际 model ID，例如 `local-model`。 |

三项完整配置后，社区版的「Mikka 默认」、Coordinator、短标题、行动标题和资料提取使用该提供方。请求直接发送到该地址，不增加 Mikka 云服务代理，不扣 Mikka 额度，也不会在失败时自动将内容发送给另一个提供方。禁止跟随 HTTP 重定向。

组织配置了模型准入规则时，需允许 `provider: "openai-compatible"`、规范化后的 endpoint、提供方实际 model ID、`servingProviders: ["openai-compatible"]` 和当前用户。每次 SDK 工具步骤前重新检查，修改或撤销规则不会被「Mikka 默认」这个 UI 别名绕过。

未配置该三项时，可以继续使用自己的 `AI_GATEWAY_API_KEY` 或原有 `ZEROCAT_BASE_URL` / `ZEROCAT_API_KEY` 路径。Coordinator 不再以运行在 Vercel 上作为社区版启用条件。云版继续保留固定 ZeroCat 路由、首 token 超时回退和现有计费。

只连接个人 Claude / ChatGPT 订阅，或为 Bot 选择自己的 API Key，也可以聊天，不需要服务器默认模型和云连接。聊天启用、消息唤醒和原有后台重试都检查这个 Bot 的真实选项、工作区权限及当前连接状态。暂停、断开、旧版本绑定或已知耗尽的订阅不会启用聊天；过期的额度读数可提交下一次正式检查，执行前仍会重新验证。明确选择「Mikka 默认」时，不会因管理员未配置它就悄悄改用个人订阅。

## Decisions

| 变量 | 默认值 / 用途 |
| --- | --- |
| `DECISION_MODEL` | 默认 `openai/gpt-6-luna-decisions`。 |
| `DECISIONS_URL` | 默认 `https://ai-gateway.vercel.sh/v1/decisions`。自配服务需实现相同的 Decisions 请求、回答和调用回执协议。 |
| `DECISIONS_API_KEY` | 自配兼容服务的专用 Bearer Key，也可用于默认 Gateway。其他兼容服务可沿用管理员指定的 `AI_GATEWAY_API_KEY`。 |
| `OPENAI_DECISIONS_API_KEY` | 原生 OpenAI Decisions 的专用凭证，用于 `https://api.openai.com/v1/decisions`。 |
| `DECISIONS_BILLING_PROFILE` | 原生端点当前支持 `openai-global-standard`。仅在账户实际使用全球标准价格时配置。 |

默认 Gateway 地址仍支持现有 `AI_GATEWAY_API_KEY` 或 Vercel OIDC。自配地址不会收到 Vercel OIDC 令牌。没有可用凭据时 `decide()` 返回 `null`，保留既有降级行为。

用户发来的消息仍直接投递到所选 Bot，原任务的正式完成结果也沿用原订阅处理，不要求先调用 Decisions。其他需要语义判断的后台事件会保持待处理，不会编造分类或额外要求用户批准。

## PostHog 与功能缺省值

`POSTHOG_HOST` 配置完整的 ingestion URL，默认 `https://us.i.posthog.com`。项目 token 仍为 `NEXT_PUBLIC_POSTHOG_KEY`；本地求值使用的 secret 仍为 `POSTHOG_SECRET_KEY`。不设置项目 token 时，不创建客户端、不发送统计。Web 前端的公开 token 和 host 属于前端构建配置；桌面客户端使用连接服务器的功能快照。

以下是没有 PostHog 时的社区版默认行为。明确设置的管理员旧环境变量仍优先；连接了 PostHog 后，明确的远程布尔值优先。云版 deployment switch 保持原有远程/旧变量回退顺序。

| Deployment switch | PostHog key | 社区版缺省 |
| --- | --- | --- |
| `credentialVault` | `mikka-credential-vault-off` | 开 |
| `agentKit` | `mikka-agent-kit-off` | 开 |
| `agentKitLiveEval` | `mikka-agent-kit-live-eval` | 关 |
| `cloudComputerTasks` | `mikka-cloud-computer-tasks-off` | 开 |
| `issueTools` | `mikka-issue-tools-off` | 开 |
| `factoryRouting` | `mikka-factory-routing-off` | 开 |
| `factoryLifecycle` | `mikka-factory-lifecycle-off` | 开 |
| `personalMailbox` | `mikka-personal-mailbox-off` | 开 |
| `personalWrites` | `mikka-personal-writes-off` | 开 |
| `skillModelEvaluation` | `mikka-skill-model-evaluation` | 关 |
| `proactiveProfile` | `mikka-proactive-profile-deployment` | 关 |
| `groupContribution` | `mikka-group-contribution-off` | 开 |
| `byos` | `mikka-byos` | 开 |
| `byosClaudeOAuth` | `mikka-byos-claude-oauth` | 开 |
| `byosCodexOAuth` | `mikka-byos-codex-oauth` | 开 |
| `byosEnrollment` | `mikka-byos-enrollment` | 开 |
| `factoryVercelPublication` | `mikka-factory-vercel-publication` | 关 |
| `factoryVercelProduction` | `mikka-factory-vercel-production` | 关 |
| `deviceUnitFence` | `mikka-device-unit-fence-off` | 开 |
| `dbEgressSample` | `mikka-db-egress-sample` | 开 |

| 按用户 / UI flag | 没有项目时的 flag 值 | 结果 |
| --- | --- | --- |
| `mikka-byos-subscription-chat` | `true` | 订阅聊天可用 |
| `mikka-byos-subscription-native` | `true` | 订阅原生线程可用 |
| `mikka-cloud-computer` | `true` | 显示自带 E2B Key 的电脑功能 |
| `mikka-computer-billing` | `false` | 不启用电脑收费 |
| `mikka-email-sign-in-off` | `false` | 邮箱登录可用 |
| `mikka-computer-tab-off` | `false` | 电脑 tab 可用 |
| `mikka-proactive-profile` / `mikka-proactive-research` | `false` | 不打开实验能力 |
| 四个 `mikka-upcoming-*` | `false` | 不显示尚未实现的功能 |
| 未知 flag | `false` | 不凭未知 key 打开能力 |
| `mikka-linear-sync` | 关闭 | 保留 Alex 关闭的全局 Linear 同步；连接自己的 Linear 账号是另一条路径 |

2026-11-07 只读核对了 Mikka PostHog 项目 `670821`：订阅 [chat](https://us.posthog.com/project/670821/feature_flags/1022059) / [native](https://us.posthog.com/project/670821/feature_flags/1022061) 为所有人 100% 开；[enrollment](https://us.posthog.com/project/670821/feature_flags/1022075) 和 [数据库采样](https://us.posthog.com/project/670821/feature_flags/1024999) 对 production 为 100% 开；已建立的 kill flags 不活动。Factory 的历史 gate 名是 `mikka-factory-routing` / `mikka-factory-lifecycle`，production 100% 开，代码已使用默认开的 `*-off` 形式。电脑 UI 的生产启用还读取 `NEXT_PUBLIC_COMPUTER_ENABLED`，不能只看远程 gate 的 inactive 状态。BYOS/OAuth 的三个历史变量 `MIKKA_BYOS_ENABLED`、`MIKKA_BYOS_CLAUDE_OAUTH`、`MIKKA_BYOS_CODEX_OAUTH` 已通过 [生产配置只读检查](https://github.com/alexj11324/Mikka/actions/runs/42316591790) 确认均为 `1`。未建立远程 flag 的项仍保留明确管理员覆盖。

## Skills 搜索

有 Vercel OIDC 时沿用身份请求；没有时直接读取 skills.sh 的公开 API。如果上游要求授权、不可用或返回不合规数据，接口返回固定 `skills_search_unavailable` / `invalid_skills_response`，不泄露上游响应。不需要 Mikka 账号或新增 Key。

## 验证

`pnpm test:self-hosted-byok` 使用真实本地 SMTP socket 和 OpenAI-compatible HTTP fixture 验证传输协议，并覆盖 S3 签名/字节往返、邮件发件人、local KMS 隔离、无 OIDC 的 skills 搜索，以及不配 PostHog 的默认行为。不会发送真实邮件、调用收费模型或访问真实用户数据。部署验收另需在隔离域名使用自己的 Mailpit/SMTP、MinIO 和浏览器凭据流程，并按项目规则验证共享测试账号的云版兼容性。
