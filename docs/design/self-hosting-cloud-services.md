# 自托管与 Mikka 云服务：照 LobeHub 的做法

- 日期：2026-11-06
- 状态：设计稿，等 Alex 审阅（PR 不合）
- 决定：[2026-11-06-2300](decisions/2026-11-06-2300-self-hosted-like-lobehub.md)
- 相关 issue：#1556（后端：发现接口、登录交接）、#1557（桌面端选择服务器）
- 先读：`AGENTS.md`、[`glossary.md`](glossary.md)、[`orchestration.md`](orchestration.md) § 7、
  [机器是执行边界](decisions/2026-11-06-1800-machine-is-the-execution-boundary.md)、
  [不新增轮询](decisions/2026-11-05-0200-no-new-polling.md)、[托管界面叠加层](decisions/2026-11-06-2000-hosted-ui-overlay.md)

## 0. 结论

1. **自托管服务器是完整的 Mikka。** 公开仓库（AGPL）里的代码不依赖任何 Mikka 自己的账号也能跑完核心流程：
   登录、bot 聊天、线程、本机和服务器 daemon、自带 E2B Key 的云电脑、自带订阅和 API Key 的模型、实时推送。
   不连云时只有第 4 节表里「只有云版有」的几项不可用，其他能力都有自带 Key 的做法。
2. **只有依赖 Mikka 自己账号和密钥的能力，才集中放在「Mikka 云服务」**，对应 LobeHub 的 Market。
   这些能力是：Mikka 的 GitHub App、按 Mikka 额度计费的云电脑、iOS 推送转发、托管模型额度、托管实时中继、
   Mikka 的 Composio 连接器。云服务是一个独立部署，代码放在新的私有仓库 `mikka-cloud`。
   它的 API 契约公开写在本仓库，LobeHub 没有公开这份契约（#10762）。
3. **连云有两种方式，都要做。**
   - 用户绑定：每个人用自己的 Mikka 云账号授权，用 OAuth 授权码加 PKCE，用量记在本人的额度上。
   - 受信客户端：管理员在 Mikka 云的团队工作区建一把「服务器密钥」，用量记在这个团队工作区上。
4. **效率第一。** 令牌在云服务端点本地验签，不额外绕一趟。
   GitHub 安装令牌是真令牌，在准备机器时直接交给机器，可以直接 `git clone`。LobeHub 给的是占位令牌，不能 clone。
   云电脑开机后，worker 直接连回自托管服务器，云服务只管开机、暂停和回收。
   唯一逐次经过云的是托管模型调用，因为 Mikka 本身就是这个模型的提供方。
5. **桌面和 iOS 不改成轮询。** 桌面继续用「系统浏览器 + 本机 loopback + PKCE」（#1556、#1557）。
   iOS 已经用 Better Auth 的 `mikka://` 回跳，换服务器只要让地址跟着账号走。
6. **一处需要 Alex 确认：** 「云电脑按 Mikka 额度计费」和 2026-10-30 的决定
   「云电脑只用自己的 E2B Key，Mikka 不收费」相反。见 § 5.2。

## 1. LobeHub 怎么做（调研，注明出处）

只读了公开文档、RFC、源码和 npm 包 `@lobehub/market-sdk@0.46.1` 的 dist，没有克隆，也没有运行任何代码。
只借鉴做法，不拷代码：他们的许可是 Apache 2.0 加附加条件，开发并分发衍生作品要先买商业许可
（[LICENSE](https://raw.githubusercontent.com/lobehub/lobehub/main/LICENSE)）。

### 1.1 协调者初稿里需要更正的地方

| 初稿 | 核实结果 | 出处 |
| --- | --- | --- |
| 用 `ENABLE_OIDC` 开关打开 OIDC | 没有这个开关，配了 `JWKS_KEY` 就自动启用。旧变量 `OIDC_JWKS_KEY` 已经改名，不再兼容 | [desktop.mdx](https://raw.githubusercontent.com/lobehub/lobehub/main/docs/self-hosting/advanced/desktop.mdx) |
| #10752、#21638、#21761、#18865 都以「不计划做」关闭 | 只有 #10752（自托管 Market）和 #10762（公开 Market API 契约）是 not_planned。#21638 和 #18865 仍然 open；#21761 是自定义 MCP 连接器的 bug，与自托管 Market 无关 | [#10752](https://github.com/lobehub/lobehub/issues/10752)、[#10762](https://github.com/lobehub/lobehub/issues/10762)、[#21761](https://github.com/lobehub/lobehub/issues/21761) |
| PR #21573 是给沙箱出口换令牌 | 范围更窄，只覆盖 widget 沙箱的出站请求。占位符格式是 `lh_ph_<32hex>`，每次运行生成一个；真令牌不进沙箱，也不经过 lobehub 服务器；占位符不能放进 git URL、query 或请求体 | [#21573](https://github.com/lobehub/lobehub/pull/21573) |
| 云沙箱一定要连 Market | 不一定，`SANDBOX_PROVIDER=onlyboxes` 可以换成自托管的 Onlyboxes | [cloud-sandbox.mdx](https://raw.githubusercontent.com/lobehub/lobehub/main/docs/self-hosting/environment-variables/cloud-sandbox.mdx) |
| 官网的桌面文档页 | 页面只渲染出占位内容，以 GitHub 上的 mdx 为准 | 同上 |

### 1.2 自托管服务器和 Market 之间怎么鉴权

LobeHub 有三条路径。

- **A. 用户绑定 LobeHub 云账号。**
  - 流程是 OIDC 授权码加 PKCE（S256），Market 是授权服务器（`{MARKET}/lobehub-oidc/auth`），
    scope 为 `openid profile email offline_access`。
  - Web 端用公开客户端 `lobechat-com`，回调地址是 `<自托管 origin>/market-auth-callback`；桌面端用 `lobehub-desktop`。
  - 自托管服务器只是把 `/market/oidc/{handoff,token,userinfo}` 转发给 Market。
    access 和 refresh token 存在自托管数据库的用户设置 `settings.market` 里。
  - access token 默认 3600 秒。refresh token 每次使用后轮换，只能用一次，所以客户端会把并发刷新合并成一次。
    撤销走 RFC 7009。
  - Market 是否接受任意自托管 origin 作为回调：未查到，Market 是私有仓库。
  - 出处：[MarketAuthProvider.tsx](https://github.com/lobehub/lobehub/blob/main/src/layout/AuthProvider/MarketAuth/MarketAuthProvider.tsx)、[oidc.ts](https://github.com/lobehub/lobehub/blob/main/src/layout/AuthProvider/MarketAuth/oidc.ts)、[market/oidc route](https://github.com/lobehub/lobehub/blob/main/src/app/(backend)/market/oidc/[[...segments]]/route.ts)。
- **B. 受信客户端。**
  - 环境变量是 `MARKET_TRUSTED_CLIENT_ID` 和 `MARKET_TRUSTED_CLIENT_SECRET`。
    secret 的格式是 `lobehub-market_tcs_` 加 64 位 hex；client ID 必须登记在 Market 的白名单里。
  - 每次请求时，服务器生成一段 `{clientId, userId, email, name, workspaceId?, nonce, timestamp, 沙箱权益}`，
    用 AES-256-GCM 加密（密钥是 secret 的 SHA-256），放进请求头 `x-lobe-trust-token`。
    Market 拒收超过 5 分钟的令牌。没有刷新，也没有撤销。
  - 自托管者怎么申请这套凭据：未查到。
  - 出处：[env/app.ts](https://github.com/lobehub/lobehub/blob/main/packages/env/src/app.ts)、[trusted-client](https://github.com/lobehub/lobehub/blob/main/src/libs/trusted-client/index.ts)、[trustTokenExpiry test](https://github.com/lobehub/lobehub/blob/main/apps/server/src/services/toolExecution/__tests__/trustTokenExpiry.test.ts)、[market-sdk](https://www.npmjs.com/package/@lobehub/market-sdk)。
- **C. 机器对机器。** SDK 还支持 `client_credentials`：用 HS256 的 client_assertion 换 1 小时的 access token；
  也支持 `MARKET_API_KEY`（出处同 SDK）。
- **反方向也有。** 自托管服务器本身是 OIDC 提供方，内置公开客户端 `lobehub-desktop`、`lobehub-mobile`
  （回调 `com.lobehub.app://auth/callback`）和 `lobehub-market`。
  access token 1 小时；refresh token 轮换，有效 30 天。
  出处：[oidc-provider/config.ts](https://github.com/lobehub/lobehub/blob/main/src/libs/oidc-provider/config.ts)、[RFC 107](https://lobehub.com/blog/rfc-107)。

### 1.3 哪些必须连云，哪些自带 Key 就行

- **自带 Key 就能用：** 模型提供商、搜索、S3 存储、Redis（[.env.example](https://raw.githubusercontent.com/lobehub/lobehub/main/.env.example)）；
  云沙箱也可以换成 Onlyboxes。
- **必须连 Market：**
  - widget 沙箱，要配受信客户端，否则报 `SANDBOX_NOT_CONFIGURED`；
  - Market 的 OAuth 连接器（GitHub、Linear、Notion、Vercel 等）：令牌存在 Market，自托管数据库只记一行
    `sourceType:'marketplace'`（[#21573](https://github.com/lobehub/lobehub/pull/21573)）；
  - MCP 和插件目录、新手模板（[#10752](https://github.com/lobehub/lobehub/issues/10752)、[#21638](https://github.com/lobehub/lobehub/issues/21638)、[#13915](https://github.com/lobehub/lobehub/issues/13915)）。
- **自托管下不生效：** 额度和订阅。词汇表原话是 "credits and subscriptions are inactive in self-hosted deployments"
  （[glossary.mdx](https://raw.githubusercontent.com/lobehub/lobehub/main/docs/glossary.mdx)）。

### 1.4 移动端和推送

- 有原生 App，能连自托管服务器，靠内置的 `lobehub-mobile` 客户端（[#15136](https://github.com/lobehub/lobehub/issues/15136)）。
  移动端源码不在公开仓库。
- 推送是服务器用 `expo-server-sdk` 直接调 Expo Push，不经过 LobeHub 云中转
  （[PushChannel.ts](https://github.com/lobehub/lobehub/blob/main/apps/server/src/services/push/PushChannel.ts)）。
  APNs 凭据在 LobeHub 的 EAS 项目里。这能成立，是因为他们的 EAS 项目没有开 Expo 的增强推送安全：
  这一点是推断，未核实。

### 1.5 实时推送和后台任务

- 默认在进程内执行（setTimeout）。设 `AGENT_RUNTIME_MODE=queue` 后改用 Upstash QStash；部分流程用 Upstash Workflow
  （[queue impls](https://github.com/lobehub/lobehub/blob/main/apps/server/src/services/queue/impls/index.ts)）。
- 流式事件在有 Redis 时走 Redis Streams 加 SSE，没有就用进程内存
  （[AgentRuntime factory](https://github.com/lobehub/lobehub/blob/main/apps/server/src/modules/AgentRuntime/factory.ts)）。
- 可选的 Agent Gateway 用 WebSocket。协议 v2 只在商业构建里，开源版是 v1；页面实时协作只有云版
  （[env/app.ts](https://github.com/lobehub/lobehub/blob/main/packages/env/src/app.ts)）。

### 1.6 计费

- 按 credits 计费，个人和工作区分开记账。套餐有 Free（每月 50 万 credits）、Plus、Pro、Max。
  定价页的卡片和对比表价格不一致（$18/$90/$180 对 $20/$100/$200）。
  沙箱存储随套餐（2/4/8 GB），自托管提供方归企业版
  （[pricing](https://lobehub.com/en/pricing)、[top-up](https://lobehub.com/docs/usage/subscription/how-to-top-up-credits)）。
- 沙箱权益放在受信令牌里传给 Market。自托管用户用 Market 沙箱怎么计费：未查到。

### 1.7 桌面登录为什么用轮询（RFC 121）

- 原因：自定义协议回调在 Windows 11 上经常唤不起 App，各系统注册不一致，部署时还遇到 Cloudflare 的问题。
- 做法：登录结果写进 `oauth_handoffs`，桌面每 3 秒轮询一次，5 分钟超时，读一次即删。
- RFC 没有拿本机 loopback 来比较，为什么不用 loopback：未查到（[RFC 121](https://lobehub.com/blog/rfc-121)）。
- Mikka 已经有 loopback 加 PKCE，不需要这个轮询，按「不新增轮询」也不能照搬。

### 1.8 Mikka 照搬什么、不照搬什么

| LobeHub | Mikka |
| --- | --- |
| 私有 Market 集中放云能力 | 照搬：私有 `mikka-cloud` |
| 不公开 Market API 契约（#10762） | **不照搬**：契约公开写在本仓库 `docs/cloud-services-api.md`，社区可以自己实现 |
| 受信令牌每次请求加密生成，不能撤销 | **不照搬**：用标准 OAuth `client_credentials`，令牌 1 小时，可以在云上立即撤销 |
| 沙箱里只放占位令牌，出口代理换真令牌 | **不照搬**（[1800](decisions/2026-11-06-1800-machine-is-the-execution-boundary.md)）：真令牌开机时交给机器 |
| 桌面靠轮询取回登录结果 | **不照搬**：继续用 loopback 加 PKCE |
| 自托管下关掉额度和订阅 | 照搬：社区版关闭计量；连上云的那部分用 Mikka 额度 |
| 推送直接调 Expo | 改成经云中转，好开 Expo 增强推送安全（§ 5.3） |

## 2. 版本和名词

| 名词 | 意思 |
| --- | --- |
| **Mikka 云**（hosted） | `app.aspectlylabs.com/mikka`，Mikka 官方运营的版本，用 BoardUI 界面（[2000](decisions/2026-11-06-2000-hosted-ui-overlay.md)） |
| **社区版**（community） | 任何人用公开仓库部署的服务器。`MIKKA_EDITION=community`，这也是没设时的默认值。云版设 `cloud` |
| **Mikka 云服务**（cloud services） | 私有仓库 `mikka-cloud` 的独立部署，只给自托管服务器调用。地址 `MIKKA_CLOUD_URL`，默认 `https://app.aspectlylabs.com/mikka/cloud`（Vercel rewrite 到这个项目，和 Mikka 云同域） |
| **已连接的服务器**（connected server） | 在 Mikka 云服务登记过的一台自托管服务器，有 `serverId` |

`MIKKA_EDITION` 会出现在发现接口（#1556）的 `edition` 字段里。

## 3. 自托管服务器怎么连 Mikka 云

### 3.1 先登记服务器（动态注册，没人需要手工审批）

1. 管理员在 社区版 › 设置 › Mikka 云 点「连接」。服务器向 `POST {MIKKA_CLOUD_URL}/v1/servers/register`
   发送自己的 origin、base path 和名称。这是 OAuth 动态客户端注册（RFC 7591），MCP 也用这个做法。
2. 云服务返回 `serverId`、`serverSecret` 和登记好的回调地址 `<origin><basePath>/api/cloud/callback`。
   服务器把 secret 用 `WORKSPACE_SECRETS_KEY` 加密后存进自己的数据库，不需要再写环境变量。
3. 一台服务器还没被任何 Mikka 账号认领时，只能发起绑定，不能调用任何能力。
   登记接口按 IP 限流，30 天没人认领的登记会被清掉。

为什么不像 #1556 评论里说的那样直接借用 Mikka 的 OAuth 客户端：
登记把回调地址精确绑定到一台服务器，同意页上显示的也是那台服务器的 origin，
所以既不会变成开放跳转，Mikka 也没有替第三方域名冒名。

### 3.2 方式一：用户绑定（每个人用自己的 Mikka 云账号）

1. 用户在 社区版 › 设置 › 账号 › Mikka 云 点「绑定」。服务器生成 PKCE，并打开
   `{MIKKA_CLOUD_URL}/oauth/authorize?client_id=<serverId>&redirect_uri=…&code_challenge=…&scope=…`。
2. 用户在 Mikka 云登录。同意页标题是「`acme.example.com` 想使用你的 Mikka 云」，下面列出 scope 和计费工作区。
   同意页没有副标题（R-40），标记是 🔒 Secured by Mikka。
3. 浏览器回到 `/api/cloud/callback`，服务器用 `code`、`code_verifier` 和 `serverSecret` 换取令牌。
4. scope 有 `github`、`computer`、`push`、`live`、`models`、`connectors`。
   计费工作区默认是这个人的个人工作区，可以选一个他有权限的团队工作区。

### 3.3 方式二：受信客户端（管理员代表全服务器）

1. 管理员在 Mikka 云 › 团队工作区 › 设置 › 已连接的服务器 点「新建服务器密钥」，选 scope 和每月上限。
   密钥只显示一次。
2. 自托管服务器配 `MIKKA_CLOUD_CLIENT_ID` 和 `MIKKA_CLOUD_CLIENT_SECRET`，也可以在设置页里填，存法同 3.1。
3. 服务器用 `client_credentials` 换 access token，用到快过期再换，不按定时器刷新。
4. 每次调用带上 `actor`：服务器本地用户 id 的 HMAC，只用于审计和按人统计，云上不存原值。
5. 用量记在这个团队工作区上。

两种方式可以同时开：一个已经绑定的人优先用自己的账号，没有绑定的人才走服务器密钥。

### 3.4 令牌

| 令牌 | 形式 | 有效期 | 存在哪 | 撤销 |
| --- | --- | --- | --- | --- |
| access token | ES256 JWT（`iss` 云服务，`aud=mikka-cloud`，`sub` 为账号或工作区，`srv`=serverId，`scope`，`jti`） | 1 小时 | 自托管服务器内存 | 撤销后的下一次调用就会被拒（见下） |
| refresh token（方式一） | 随机 32 字节，云上只存哈希 | 30 天，每次使用后轮换；旧的一个用两次视为泄露，整条链作废 | 自托管数据库，加密存放 | 用户在云上 设置 › 已连接的服务器 › 断开，或者调用 RFC 7009 接口 |
| 服务器密钥（方式二） | `mkc_` 前缀加 32 字节，云上只存哈希 | 不过期，可以轮换 | 自托管数据库或环境变量 | 管理员在云上删除 |
| serverSecret | 同上 | 不过期，可以轮换 | 自托管数据库 | 在云上删除这台服务器，它所有的令牌一起作废 |

- **验签在端点本地完成。**
  - 每个能力端点自己验 JWT，再查一张内存里的撤销集合：撤销的 `srv`、`sub` 和 `jti`，
    由云服务进程内的 live 推送更新，不定时去拉。
  - 请求本来就要打到云服务，所以这一步不额外多一次往返。
  - 撤销一台服务器、一个绑定或一把密钥后，下一次调用立即被拒。
- **撤销会推送停止。**
  - 撤销时，云服务停止并回收这台服务器名下的云电脑（按 1800 决定：推送停止，不等下一次调用）；
  - 吊销这台服务器还没过期的 GitHub 安装令牌（`DELETE /installation/token`）。
- **签名密钥。** JWKS 公开在 `{MIKKA_CLOUD_URL}/.well-known/jwks.json`，每 90 天轮换，新旧两把并存 24 小时。

## 4. 盘点：Mikka 代码里依赖自家账号、密钥和服务的地方

分四类：**原样能用**、**自带 Key**（自托管者填自己的就能用）、**要换做法**（代码要改才能在自托管下用）、**只有云版有**（不连云就没有，连云能用的见 § 5）。

| 能力 | 文件 | 环境变量（只列名字） | 分类 | 自托管怎么做 |
| --- | --- | --- | --- | --- |
| 数据库 | `lib/db/*`、`scripts/migrate.mjs` | `MIKKA_DATABASE_URL`、`MIKKA_DATABASE_URL_UNPOOLED` | 原样能用 | 普通 Postgres。`NEON_API_KEY` 只用于运维出口统计，可以不配 |
| 邮箱登录 | `lib/auth.ts`、`lib/auth-config.ts` | `BETTER_AUTH_URL`、`BETTER_AUTH_SECRET`、`AUTH_TRUSTED_ORIGINS` | 原样能用 | `BETTER_AUTH_URL` 必须和对外地址一致（#1556 启动检查）；`AUTH_TRUSTED_ORIGINS` 要带上 `mikka://`，iOS 才能回跳 |
| Google / GitHub 登录 | 同上 | `GOOGLE_CLIENT_*`、`GITHUB_CLIENT_*` | 自带 Key | 自己注册 OAuth 应用（#1556 评论）。**不借用** `BETTER_AUTH_OAUTH_PROXY_*` |
| 发信 | `lib/auth-email.ts`（发件人写死为 `noreply@aspectlylabs.com`）、`lib/account/mail.ts`、`lib/abuse/alerts.ts` | `RESEND_API_KEY` | 要换做法 | 发件人改由 `MIKKA_EMAIL_FROM` 配置；加 SMTP（`SMTP_URL`）。云服务**不代发**，否则就是冒用我们的域名 |
| GitHub App 和 webhook | `app/api/webhooks/github/route.ts`、`lib/suggestions/github-webhook.ts`、`lib/suggestions/github-redelivery.ts`、`lib/github/user-access.ts`、`lib/github/repository-installation.ts`、`lib/github/repository-match.ts`（安装地址写死 `apps/mikka-github`） | `GITHUB_APP_ID`、`GITHUB_APP_PRIVATE_KEY`、`GITHUB_WEBHOOK_SECRET` | 自带 Key（用 Manifest 一键创建）；或连云代理 | § 5.1 |
| E2B 云电脑 | `lib/secrets/e2b.ts`、`lib/secrets/e2b-runtime.ts`、`lib/cloud-computer/thread-machines.ts`、`lib/cloud-template-models.ts`、`packages/daemon/src/hosted-binaries.ts` | 用户自己的 E2B Key（存在库里）；`E2B_*_TEMPLATE`、`MIKKA_CLOUD_TEMPLATE_MODELS`、`MIKKA_CLOUD_WORKER_*` | 自带 Key，原样能用 | 已经是每人用自己的 E2B Key（2026-10-30）。模板用 Mikka 公开发布的版本，没配时回退到 E2B 官方的 `claude`、`codex`、`desktop`。`MIKKA_CLOUD_WORKER_URL` 指向自托管服务器自己 |
| 网站密码箱 | `services/credential-broker/*`、`lib/credentials/{kms,oidc,broker}.ts` | `CREDENTIAL_*`、`AWS_REGION` | 要换做法 | 现在依赖 AWS KMS 加 Vercel OIDC。加一个本地主密钥后端（信封加密，主密钥是 `CREDENTIAL_MASTER_KEY`），broker 在同一进程里跑 |
| 额度和 Stripe | `lib/billing/*`、`lib/abuse/{card,card-checkout,policy,store}.ts`、`lib/credit-shares.ts`、`app/api/billing/stripe/route.ts` | `STRIPE_*`、`MIKKA_FREE_MODEL_*` | 只有云版有 | 社区版关闭计量和银行卡验证（同 LobeHub）：自带订阅和 API Key 不受额度限制，「计费」页隐藏。现在没有关闭开关，用完 20 条就卡在 `verification_required` |
| 托管默认模型（ZeroCat） | `lib/abuse/zerocat.ts`、`lib/abuse/model.ts`、`lib/model-admission/contract.ts`（端点写死成常量） | `ZEROCAT_*` | 只有云版有；社区版要换做法 | 社区版让管理员配一个 OpenAI 兼容的提供方（`MIKKA_DEFAULT_MODEL_BASE_URL`、`_API_KEY`、`_ID`），当作「Mikka 默认」；连云则用 § 5.5 |
| AI Gateway | `lib/ai-gateway-auth.ts`、`lib/coordinator/wake*.ts` | `AI_GATEWAY_API_KEY`、`VERCEL_OIDC_TOKEN` | 自带 Key | 填自己的 Gateway Key。Coordinator 的启用条件改为「有可用的默认模型」，不再要求 `VERCEL=1` |
| Decision 模型 | `lib/coordinator/decision.ts`（模型和地址都是常量）、`lib/coordinator/decide.ts` | — | 自带 Key 或连云 | 改成可配置：`DECISION_MODEL`、`DECISIONS_URL`。没有时 `decide()` 返回 null，群聊判断自动退化（现在也是这样）。连云时走 `/v1/decisions`（§ 5.5） |
| Composio 和插件商店 | `lib/composio*.ts`、`lib/plugins/{catalog,store,runtime,mcp,credential-connect*}.ts`、`app/api/integrations/composio/*`、`app/api/webhooks/composio` | `COMPOSIO_API_KEY`、`COMPOSIO_CALLBACK_VERIFIER_URL`、`COMPOSIO_WEBHOOK_SECRET` | 自带 Key；或连云 | 自托管者用自己的 Composio 项目，托管 auth config 属于那个项目，原样能用。连云见 § 5.6 |
| Skills 搜索 | `app/api/skills/search/route.ts` | 要求 Vercel OIDC | 要换做法 | 离开 Vercel 时改为直接请求 skills.sh 的公开接口；不行就返回「不可用」 |
| Linear | `lib/linear-sync/*`、`app/api/webhooks/linear`、`cloudflare/linear-sync/`（绑在 Mikka 的 Cloudflare 账号上） | `LINEAR_*` | 自带 Key | 自己注册 OAuth 应用。定时同步由 § 6 的内置调度器跑。Alex 定过默认关 |
| Slack / Telegram | `lib/slack/*`、`lib/telegram/*`、`workflows/slack` | `SLACK_*`、`TELEGRAM_*` | 自带 Key | 自己的 bot |
| PostHog | `lib/posthog-*.ts`、`lib/feature-flags.ts`、`lib/deployment-switches.ts`、`lib/tracing/*`（地址写死为 US 区） | `NEXT_PUBLIC_POSTHOG_KEY`、`POSTHOG_SECRET_KEY` | 要换做法 | 不配时不发任何数据。**每个 flag 不配时要等于生产上的默认值**（按「功能默认开」），不能因为没有 PostHog 就整体关掉；地址改成可配置 |
| 实时推送 `lib/live/*` | `lib/live/{notify,scope}.ts`、`app/api/live/ticket/route.ts`、`hooks/use-live-key.tsx`、Worker `cloudflare/device-gateway`（Durable Object） | `DEVICE_GATEWAY_URL`、`DEVICE_GATEWAY_PUSH_SECRET` | 要换做法 | 现在不配时 ticket 返回 `url:null`，页面就收不到更新。加一个内置后端（§ 6）；也可以自己部署这个 Worker，或者用云中继（§ 5.4） |
| 设备网关（daemon） | 同一个 Worker；`lib/device-gateway-*.ts`、`packages/daemon/src/device-gateway.ts`、`packages/daemon/src/cli.ts`（默认服务器写死） | 同上 | 要换做法 | 同上；daemon 用 `--server` 指定服务器（已支持） |
| 后台流程（Vercel Workflow） | `workflows/*`、`apps/api/plugins/workflow-world.ts`、`lib/workflow-wake.ts` | `WORKFLOW_TARGET_WORLD`、`WORKFLOW_LOCAL_*` | 要换做法 | Docker 版用 `local` world（文件存储，单节点）。多节点要一个 Postgres world：社区是否已有现成实现，未核实 |
| 定时任务 | `cloudflare/suggestions-cron`（`MIKKA_URL` 写死）调用 `/api/cron/*` | `CRON_SECRET` | 要换做法 | 内置调度器（§ 6），任何外部 cron 也能调用 |
| 文件存储 | `lib/artifacts/storage.ts`（只支持 R2，按账号拼地址） | `R2_*` | 要换做法 | 改成任意 S3 兼容存储：`S3_ENDPOINT`、`S3_BUCKET`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`；没配时存在数据库里（现在只有非生产环境这样） |
| iOS 推送 | `lib/mobile-push.ts`（直接调 `exp.host`） | `EXPO_ACCESS_TOKEN` | 只有云版有 | 官方 App 的 APNs 凭据在 Mikka 的 EAS 项目里。自托管经云转发（§ 5.3），不连云就没有推送 |
| iOS OTA | `apps/mobile/app.json`、`eas.json`、`app.config.ts`（Mikka 的 EAS 项目） | `EAS_PROJECT_ID` | 原样能用 | 自托管用户装的就是官方 App，OTA 由 Mikka 发布，和服务器无关。兼容性靠发现接口的版本字段 |
| iOS 连服务器 | `apps/mobile/lib/config.ts`（地址写死为生产） | `EXPO_PUBLIC_API_URL` | 要换做法 | 照 #1557 做：选择服务器，地址按账号记住（§ 7） |
| 桌面连服务器 | `apps/desktop/src/main/bundled-{policy,auth}.ts`、`security.ts` | — | 要换做法 | #1556、#1557 |
| 其他写死的生产地址 | `apps/desktop/scripts/build.mjs`、`packages/daemon/src/server-link-http.ts`、`lib/daemon-commands.ts`、`apps/api/runtime/request-authority.ts`、`lib/mcp/resource.ts` | — | 要换做法 | 全部改为从 `BETTER_AUTH_URL` 或 `lib/base-path.ts` 推出来 |
| Infisical | 运行时只有 BYOS 订阅：`lib/subscription-runtime.ts`、`lib/subscription-enrollment-runtime.ts`、`packages/subscription-worker` | `MIKKA_BYOS_*` | 自带 Key | 用自己的 Infisical 项目；不开 BYOS 时完全不需要。其他用法都只在运维层面 |
| Turnstile、Firecrawl | — | `NEXT_PUBLIC_TURNSTILE_SITE_KEY`、`FIRECRAWL_API_KEY` | 自带 Key | 可以不配 |
| Vercel 运行时 | `apps/api/nitro.config.ts`（`NITRO_PRESET=vercel`）、`@vercel/functions`、`@vercel/analytics` | `VERCEL_*` | 要换做法 | Docker 镜像用 Nitro 的 `node-server` preset；`waitUntil` 离开 Vercel 后的行为由 P0-1 实测 |
| 部署形态 | 仓库里没有 Dockerfile 或 docker-compose（只有测试用的 `tests/ssh-install/Dockerfile`） | — | 要换做法 | P0-1：官方镜像和 compose |

## 5. 每项云能力怎么做

公共约定：

- 所有端点都在 `{MIKKA_CLOUD_URL}/v1/*`，要求 `Authorization: Bearer <access token>`；
- 错误用 `CodedError` 的固定码（`cloud_not_connected`、`cloud_scope_missing`、`cloud_quota_exhausted`、
  `cloud_server_revoked`……），每个码在 `messages/*.json` 的 `RunErrors.*` 里都有中英文文案
  （[0330](decisions/2026-11-05-0330-error-causes.md)）；
- 自托管侧的客户端是 `lib/cloud-services/*`，在公开仓库。

### 5.1 GitHub

**连云：用 Mikka 的 GitHub App 代理。**

1. **关联安装。** 用户在自托管服务器点「安装 GitHub App」，跳到 `github.com/apps/mikka-github/installations/new`，
   `state` 由云签发并带着 `serverId`。安装完回到云服务的 `/v1/github/setup`，云记下
   `installation_id ↔ (serverId, 计费账号)`，再 302 回自托管服务器。
   - 方式一下，云会用这个人在云上的 GitHub 身份确认他有权管理这个安装；
   - 方式二下，由管理员完成安装，安装归这个团队工作区。
2. **安装令牌。** `POST /v1/github/installation-token {installationId, repositories?, permissions?}`
   返回 GitHub 原生的安装令牌（1 小时有效）。
   - 云只发给这个安装关联的服务器，权限可以收窄到某几个仓库；
   - 自托管服务器在准备机器时直接把真令牌交给机器，`git clone` 和 `gh` 都能直接用；
   - 快过期时在后台续一张，按 1800 决定走 CLI 自己的凭据机制，不加逐次代理。
3. **Webhook 先到云。**
   - GitHub 把事件发到 `{MIKKA_CLOUD_URL}/v1/github/webhook`，云验 `x-hub-signature-256`，
     再按 `installation.id` 找到关联的服务器。
   - 然后 `POST <服务器>/api/cloud/webhooks/github`：原样转发 GitHub 的请求体，另加
     `Mikka-Cloud-Signature: t=<秒>,v1=<HMAC-SHA256(serverSecret, t.body)>`，时间窗 5 分钟，
     并带上 `x-github-delivery` 去重。
   - 自托管端只验签，后续处理复用 `app/api/webhooks/github` 的现有逻辑。
4. **失败重投。** 失败时按指数退避重投 24 小时，投递记录在云上。这是推送，不是轮询。
   - 服务器不能从公网访问时，第一期不支持，界面写明「需要公网地址」；以后需要再加出站 WebSocket。
5. **费用。** 免费，每台服务器每小时上限 5000 张令牌，和 GitHub 自己的速率同一量级。

**不连云：用 GitHub App Manifest 一键创建自己的 App。**

1. 管理员在 设置 › GitHub 点「创建 GitHub App」，可以选个人或组织。服务器生成 manifest：名称、回调、
   webhook 地址 `<origin><basePath>/api/webhooks/github`、权限（照抄 Mikka App 现在的权限）、事件，
   再用表单 POST 到 `https://github.com/settings/apps/new`（组织是 `/organizations/<org>/settings/apps/new`）。
2. GitHub 回到 `<origin>/api/github/manifest/callback?code=…`。服务器调用
   `POST /app-manifests/{code}/conversions`，拿到 `id`、`slug`、`pem`、`webhook_secret`、`client_id` 和 `client_secret`，
   加密存进数据库。
3. 安装地址改用这里得到的 `slug`，不再写死 `mikka-github`。原来的环境变量（`GITHUB_APP_*`）作为备选，继续有效。

### 5.2 云电脑（按 Mikka 额度计费）

**需要 Alex 确认。** 2026-10-30 定过「云电脑只用自己的 E2B Key，Mikka 不收云电脑的费用」，
计费界面藏在 `mikka-computer-billing` 后面。本节给连上云的自托管服务器加一个**可选**的
「用 Mikka 额度」，不改 Mikka 云上现有的规则，也不去掉自带 E2B Key。
如果 Alex 不要，这一节就整个不做。

1. **开机。** `POST /v1/computers {template, timeoutMs, metadata}`。
   - 云用 Mikka 的 E2B 团队创建 `secure` 沙箱，模板就是现在公开发布的 Mikka 模板；
   - 返回 `sandboxId`、`envdAccessToken`（只对这一台沙箱有效）和 `domain`。
2. **开机后不再经过云。** 自托管服务器拿 envd 令牌直接往机器里写 handoff
   （和 `thread-machines.ts` 现在一样），worker 直接连回自托管服务器。
   命令、文件和模型调用都不经过云，开机和运行的速度和用自己的 E2B Key 时一样。
3. **生命周期。** 暂停、继续、回收走 `POST /v1/computers/:id/{pause,resume,kill}`，只在状态改变时调用。
4. **计费。**
   - 云按 E2B 的计费规则（只算运行中的时间）记账，单价 = E2B 价格 × 加价，加价由 Alex 定。
   - 开机前预留 15 分钟的额度，之后每 15 分钟结算一次。这是云在调用自己的 E2B 账单接口，不是自托管在轮询。
   - 余额不足时，云先通知自托管服务器（`cloud_quota_exhausted` 事件，走 webhook 通道），再暂停机器。
5. **上限。** 沿用 2026-10-29 的限额：每人 3 台、每个工作区 20 台、每人 30 天 60 小时、单台最长 12 小时。
   计在付费账号上。
6. **准入。** 和 Mikka 云的托管准入一致：付费的人要验证过银行卡，并且余额大于 0。

### 5.3 推送转发（iOS）

- 自托管服务器调用 `POST /v1/push {to: ExpoPushToken[], title, body, data, collapseId}`。
  云用 Mikka 的 `EXPO_ACCESS_TOKEN` 交给 Expo，并按服务器和用户限流。
- 打开转发以后，Mikka 的 EAS 项目可以开启 Expo 的增强推送安全，从此只有带 Mikka 令牌的请求才能推到官方 App，
  别人拿到 push token 也推不了。LobeHub 是直接调 Expo。
- **隐私。** 推送内容会经过云，但不落库，日志里只记数量。服务器可以选「只推提醒」：正文换成「新消息」，
  App 收到后自己去服务器取。
- 不连云就没有推送，App 打开时仍然靠 live 推送更新。
- 费用：免费，每台服务器每天上限 1 万条。

### 5.4 实时推送

- **默认：内置后端**（§ 6，不用云）。这是自托管的主路径，Docker 单机或多节点都能用。
- **可选：自己部署 `cloudflare/device-gateway`。** 它是公开的，配 `DEVICE_GATEWAY_URL` 就行，和 Mikka 云一样。
- **可选：云中继。** 给跑在 Vercel 这类 serverless 平台、没法保持长连接，又不想自己部署 Worker 的服务器用。
  - Worker 加一层租户隔离：每台服务器的推送密钥是 `HMAC(master, serverId)`，channel 加上 serverId 前缀。
    Worker 按 ticket 里的 serverId 推出密钥来验签，不用查表。
  - 自托管服务器通过 `POST /v1/live/credentials` 拿到自己的密钥，之后直接往 Worker 推送，不经过云服务。
  - 桌面已经接受任意 `wss://` 主机（#1556 评论），客户端不用改。
  - 优先级最低，有真实用户需要再做（P3）。

### 5.5 托管模型额度（Mikka 默认、Decision）

- `POST /v1/models/chat/completions`（OpenAI 兼容，流式）和 `POST /v1/decisions`。
  - 云内部复用 Mikka 云现在的路由：ZeroCat，首 token 超过 20 秒退回 AI Gateway；
  - 预留和结算额度用现有的 `lib/abuse/store.ts`；
  - 付费账号由令牌的 `sub` 决定。
- 这是唯一逐次经过云的调用。Mikka 本身就是这个模型的提供方，Mikka 云上的调用也一样要先过额度，
  所以不算多绕一趟。Vercel 区域选和 ZeroCat 最近的。
- 写代码的 Agent（Claude Code、Codex）在机器上直接用订阅，不经过这里。
- 自托管侧在「模型与订阅」里显示「Mikka 默认（Mikka 云额度）」，只在绑定了 `models` scope 后出现。

### 5.6 连接器（Composio）

- 自带 Composio Key 是主路径（§ 4）。
- 连云后可以用 Mikka 的 Composio 项目，免去自托管者自己注册：
  - 授权走 `/v1/connectors/:toolkit/authorize`（回调到云，再回到服务器）；
  - 执行走 `/v1/connectors/execute`。
- 这些调用每次都经过云，因为 Composio 的 Key 按项目授权，不能交给第三方服务器。所以放在 P3，
  有真实用户再做。
- 插件商店的目录（公开数据）从 `/v1/catalog` 读，服务器缓存 1 小时。

### 5.7 费用汇总

| 能力 | 收费 | 计在谁头上 |
| --- | --- | --- |
| GitHub App 代理、webhook 转发、推送转发、实时中继、插件目录 | 免费，按服务器限流 | — |
| 云电脑 | Mikka 额度（等 § 5.2 确认） | 方式一：本人选的工作区；方式二：密钥所属的团队工作区 |
| 托管模型、Decision | Mikka 额度，单价和 Mikka 云相同 | 同上 |
| Composio 连接器 | 免费，按服务器限流 | — |

额度就是现在的 Mikka 额度（100 点 = 1 美元），充值、银行卡验证和共享额度都沿用 Mikka 云的规则
（`orchestration.md` § 7），不另起一套。

## 6. 不连云也能跑：内置的后台能力（P0，公开仓库）

- **实时推送的内置后端。**
  - `lib/live/notify.ts` 增加一个后端：服务器进程内维护 WebSocket（`/api/live/socket`）；
    多节点之间用 Postgres `LISTEN/NOTIFY` 互相广播。
  - ticket 签发逻辑不变，只是 URL 换成本服务器自己的地址。设备网关的 daemon 通道也走同一个进程。
  - 这是推送，不是轮询，满足 [0200](decisions/2026-11-05-0200-no-new-polling.md)。
  - 有 `DEVICE_GATEWAY_URL` 时仍然优先用 Worker，所以 Mikka 云不受影响。
- **内置调度器。** 一个进程内的 cron（每分钟一次），调用现有的 `/api/cron/*`。
  它取代外部的 `cloudflare/suggestions-cron`，不是新增的数据轮询；
  写进 `scripts/polling-policy.mjs` 的白名单，理由写「自托管 cron 调度器，替代 Cloudflare cron」。
  设了 `MIKKA_EXTERNAL_CRON=1` 就关掉，交给外部 cron。
- **工作流。** `WORKFLOW_TARGET_WORLD=local`，数据目录挂卷，单节点运行。多节点放到以后。
- **镜像。** `ghcr.io/alexj11324/mikka:<版本>`，Nitro 用 `node-server` preset；
  `docker-compose.yml` 只有 app 和 postgres 两个服务；第一次启动时跑 `scripts/migrate.mjs`。

## 7. 桌面和 iOS 怎么连自托管服务器

- **桌面**（#1556、#1557）：
  - 登录继续是「系统浏览器 → `/api/desktop/return` → 本机 `127.0.0.1` → PKCE exchange」，
    `mikka-auth://` 只负责把 App 拉回前台（[1900](decisions/2026-11-06-1900-desktop-sign-in-returns-to-the-app.md)）。
  - 不加 LobeHub 那样的 `oauth_handoffs` 轮询。
  - 发现接口在现有字段之外加一个 `cloud: { connected: boolean }`，只用来显示，桌面不需要据此做逻辑。
- **iOS**（新 issue P2-4）：
  - 登录页加「Mikka 云 / 自托管服务器」，填地址后先调发现接口（和桌面同一个接口、同样的错误提示）；
  - 服务器地址按账号存在 SecureStore，`API_URL` 不再写死；
  - Google、GitHub 和邮箱登录沿用 Better Auth expo 插件加 `mikka://` 回跳，只要自托管服务器的
    `AUTH_TRUSTED_ORIGINS` 里有 `mikka://`（发现接口可以检查，缺了就提示管理员）；
  - 实时推送按 ticket 返回的地址连接；
  - 推送 token 登记在用户自己的服务器上，服务器经云转发（§ 5.3）。
  - 官方 App 的 OTA 仍由 Mikka 发布；服务器太旧时，按发现接口的版本字段提示升级。

## 8. 代码放哪

判断原则照 LobeHub：自托管要能独立跑的核心功能留在公开仓库；只有连 Mikka 云才有的**服务端**能力放进私有仓库。
另外两条：已经公开的代码，没有实际收益就不搬；搬一次会和正在做的几十个 PR 冲突。

| 模块 | 建议 | 理由 |
| --- | --- | --- |
| `lib/plugins/*`（store、catalog、runtime、MCP 执行、`credential-connect*`、`skill-source`） | **留公开** | 社区版用自己的 Composio Key 和 MCP 就要跑这些，是核心 |
| 云端连接器代理（§ 5.6）、插件目录服务 | **私有 `mikka-cloud`** | 要用 Mikka 的 Composio 项目 |
| `apps/api/plugins/*`（request-authority、security-headers、workflow-world） | **留公开** | 每个部署都要的服务器插件 |
| `services/credential-broker`、`lib/credentials/*` | **留公开**，加本地密钥后端 | 密码箱是核心功能；KMS 适配器里没有秘密 |
| GitHub：webhook 处理、安装令牌的使用、Manifest 流程 | **留公开** | 自带 App 要用 |
| GitHub：Mikka App 的私钥、安装和服务器的关联、webhook 分发 | **私有 `mikka-cloud`** | 只有云有 |
| 计费、额度、Stripe（`lib/billing/*`、`lib/abuse/*`、`lib/credit-shares.ts`） | **现在留公开**，加社区版开关；以后可以搬 | Mikka 云本身就是从公开仓库部署的，要搬得先给服务端也做一层叠加机制，还会和进行中的 PR 冲突。真要搬时，先在公开仓库留接口（`HostedUsage`，社区版是空实现），再一次性搬实现 |
| 跨服务器计量（§ 5.2、§ 5.5 的服务器侧记账） | **私有 `mikka-cloud`** | 只有云有 |
| ZeroCat 和托管模型路由（`lib/abuse/zerocat.ts`、`model.ts`） | **留公开**，端点改成可配置 | Mikka 云自己要用；社区版用它接管理员配的 OpenAI 兼容提供方 |
| `/v1/models`、`/v1/decisions` 给其他服务器用的入口 | **私有 `mikka-cloud`** | 只有云有 |
| 推送：`lib/mobile-push.ts` | **留公开**，改成可以调云转发 | — |
| 推送转发服务 | **私有 `mikka-cloud`** | 用 Mikka 的 Expo 令牌 |
| `cloudflare/device-gateway`（实时推送、设备网关） | **留公开** | 自托管者可以自己部署；内置后端也在公开仓库 |
| 云中继的租户密钥签发 | **私有 `mikka-cloud`** | — |
| `cloudflare/suggestions-cron`、`cloudflare/linear-sync` | **留公开** | 只是 Mikka 云的部署配置；自托管用内置调度器 |
| 云服务的同意页和「已连接的服务器」管理页 | **私有 `mikka-cloud`**（由它自己提供页面，挂在同域 `/mikka/cloud/*`） | 只有云有；公开仓库不用为这个加云版专用页面 |
| 社区版「设置 › Mikka 云」、`lib/cloud-services/*` 客户端 | **留公开** | 自托管服务器要用 |
| 托管版界面 | **已在私有 `mikka-hosted-ui`** | 不变，只管长相（[2000](decisions/2026-11-06-2000-hosted-ui-overlay.md)） |
| `docs/cloud-services-api.md`（API 契约、错误码、签名格式） | **留公开** | 和 LobeHub 不同，允许社区自己实现 |

**云服务仓库建议放私有。**

- 它管的是 Mikka 自己的密钥、反滥用策略和多租户记账，没有人需要自托管它（LobeHub 也是这么判断的，#10752）。
- 它和 `credential-broker` 一样是独立的 Vercel 项目，连同一个生产库，表放在独立的 schema `cloud` 里，
  迁移由私有仓库自己管。
- 它可以按 Aspectly Labs 的商业许可，以 git 子模块或包的方式复用公开仓库的 `lib/*`（AGPL 代码的版权方是
  Aspectly Labs；贡献者按 CONTRIBUTING「License」第 2 条授权了再许可）。

**`mikka-enterprise`。**

- 本 session 没有权限读这个仓库，内容未查到。
- 仓库元数据显示它是**公开**的，但描述写着「Private enterprise overlay」。**请 Alex 确认**：
  如果它本来应该是私有的，现在就改成私有。
- 分工建议：`mikka-enterprise` 放卖给自托管客户、在**他们自己服务器上**跑的商业功能（比如 SSO、SAML、审计导出），
  按商业许可提供；`mikka-cloud` 放**Mikka 自己运营**的服务。两者不合并。

**已经按 AGPL 发布过的代码。**

- 已经发布的每个版本永远是 AGPL，任何人都可以继续按 AGPL 使用和分叉。搬走只影响以后的开发。
- 贡献者在 CONTRIBUTING「License」第 2 条里授权了 Aspectly Labs 以其他条款再许可，所以搬进私有仓库的代码
  不需要再取得他们的同意。
- 公开仓库里留下的接口和社区版实现仍然是 AGPL。

**搬迁顺序，以及怎么不和进行中的 PR 冲突。**

1. 现有代码第一步都**不搬**。新的云服务代码一开始就写在 `mikka-cloud`，公开仓库里只加客户端和契约。
   这一步和任何进行中的 PR 都不冲突。
2. 加一个 CI 检查 `scripts/cloud-boundary-policy.mjs`：公开仓库里不许出现 `MIKKA_CLOUD_SIGNING_KEY`、
   GitHub App 私钥分发、Expo 令牌转发这类只属于云的服务端代码。白名单写明理由，以后不会越界。
3. 如果以后决定搬计费：
   - 先合一个只加接口的 PR；
   - 然后挑一个 PR 少的时段，开一个**只删文件**的 PR，同时在 `mikka-cloud` 加回实现；
   - 动手前在协调者那里宣布要冻结哪些路径，正在改这些路径的 PR 先合；
   - 走 batch 分支（`docs/dev-workflow.md` § 5）。

## 9. 许可和收费的对应关系

| 产品 | 许可 | 收费 |
| --- | --- | --- |
| 社区版（自托管） | AGPL-3.0-only | 免费。连上云后，云电脑和托管模型按 Mikka 额度收费；其他云能力免费、限流 |
| 商业许可 | Aspectly Labs 商业条款（NOTICE） | 想修改又不想公开代码、或者要 `mikka-enterprise` 功能的公司 |
| Mikka 云（官方托管） | 服务条款；BoardUI 界面在私有 `mikka-hosted-ui` | Mikka 额度和团队订阅（现有的 Stripe） |
| Mikka 云服务 | 私有 `mikka-cloud`，服务条款 | 按 § 5.7 |

和 LobeHub 不同的地方：他们是 Apache 2.0 加「不能分发衍生作品」，Mikka 是 AGPL：改了可以分发，但网络服务也要公开源码。
所以商业许可卖的是「免除 AGPL 义务」，不是「允许修改」。

## 10. 分期和 issue

| 阶段 | Issue | 依赖 |
| --- | --- | --- |
| P0-1 #1560 | 自托管基础：Docker 镜像和 compose、`MIKKA_EDITION`、去掉写死的生产地址和 App slug、社区版关闭计量 | — |
| P0-2 #1561 | 不用 Cloudflare 的内置实时推送、设备网关和调度器 | P0-1 |
| P0-3 #1562 | 自带 Key 补全：SMTP 和发件人、S3 兼容存储、密码箱本地密钥、OpenAI 兼容的默认模型、Decision 可配置、PostHog 缺省值 | P0-1 |
| P0-4 #1563 | GitHub App Manifest 一键创建 | P0-1 |
| #1556 | 发现接口和登录交接（已有；实时推送部分交给 P0-2，测试实例用 P0-1 的镜像） | P0-1、P0-2 |
| #1557 | 桌面选择服务器（已有，基本不变） | #1556 |
| P1-1 #1564 | Mikka 云服务骨架：`mikka-cloud`、服务器登记、两种连接方式、令牌、撤销、API 契约 | P0-1 |
| P2-1 #1565 | GitHub App 代理和 webhook 转发 | P1-1 |
| P2-2 #1566 | 推送转发 | P1-1 |
| P2-3 #1567 | 托管模型和 Decision 额度 | P1-1 |
| P2-4 #1568 | iOS 连接自托管服务器 | #1556 |
| P2-5 #1569 | 云电脑按 Mikka 额度计费（等 Alex 确认 § 5.2） | P1-1 |
| P3-1 #1570 | 云实时中继、云端 Composio 连接器（有真实用户需要再做） | P1-1 |
| P3-2 #1571 | 云边界 CI 检查 | P1-1 |

验收：每个 issue 都用不同于生产的域名起一个自托管实例。连云的 issue 先连到 Mikka 云的 preview 或测试项目
（不是生产），再在生产上用共享测试账号验收。涉及模型的验收按 `AGENTS.md`，两条订阅路径各跑一次。
