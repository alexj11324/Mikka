# 密码箱（Secured Login）：调研与交接给 Codex

日期 2026-10-27。对象：负责救 #313 的 Codex。范围：网页分身的登录与密码保存（#180）。
设计来源：`rules.md` R-72、`cloud-computer-backend.md` § 2「Login」、`decisions.md`
2026-10-27 各行；Figma `zPe5LKycb2XuT1ivCLRw07` 页「建议卡片 · 点一下就开始（v2）」
帧 E `332:5816`、过渡 `342:6595`、F `342:6337`、G `332:6066`，组件 Mobile/LoginCard
`340:6372`。

## 1. 要做成什么

照 Hark 的 Secured Login：

1. 网页分身遇到登录页 → 停在 `needs_you`，Cloudflare 那张实时卡片显示 ⚠ 需要你操作。
2. bot 在聊天里说一句（「Cloudflare 的登录卡片发好了，填上邮箱和密码，我就用它登录。」），
   下面出一个 **登录 Cloudflare** 药丸。用户也可以说「重新发一下登录卡片」，bot 再发一个。
3. 点药丸 → 原地放大成登录卡：logo、登录 <站点>、✕；邮箱、密码；Google、Apple、登录；
   🔒 Secured by Mikka。卡里不写说明句子（R-40）。
4. 提交后密码**保存**到密码箱，填进分身自己的浏览器，分身继续干活；卡片收成「已登录 Cloudflare ✓」。
5. 以后同一工作区、同一网站自动登录，不再问；用户可在设置里删除。
6. 模型永远拿不到密码；日志、聊天记录、截图、遥测里都不能出现。

## 2. 行业怎么做（调研结论）

| 产品 | 存在哪 | 怎么进浏览器 | 模型看得到吗 | 每次要批准吗 | 复用登录态 |
|---|---|---|---|---|---|
| Hark Secured Login | Hark 云端加密保险箱（无公开技术文档，细节未证实） | 云端机器登录 | 宣称看不到 | 仅付款 | 未知 |
| 1Password Agentic Autofill + Browserbase | 用户自己的 1Password（零知识） | 端到端加密通道 → 无头浏览器里的 1Password 扩展填表，填完清掉 | 看不到 | 每次在桌面端批准 | Browserbase Contexts |
| Skyvern | 自带存储或 Bitwarden/1Password/Azure Key Vault；它的库里只存元数据 | 直接打进输入框，提示词和日志里只有占位符 | 看不到，截图可打码 | 否 | 保存登录后的浏览器；TOTP 种子可存 |
| Browser Use `sensitive_data` | 调用方内存 | LLM 之后再 DOM 填写，按网址绑定 | 只看到占位符 | 否 | `storage_state`；域名白名单出过绕过漏洞（CVE-2025-47241） |
| OpenAI ChatGPT agent | 不存 | 用户接管自己输入，期间不截图 | 看不到 | 每次自己输 | cookie 保留 |
| Manus | 不存密码，存加密的登录态 | 用户自己登录 | 看不到 | 接管 | 是 |
| Devin | 加密存储的 secrets | 环境变量 | **看得到** | 否 | cookie secret |
| Perplexity Comet | 本机或 1Password | 扩展填写 | 看不到；但出过提示注入把 1Password 网页版密码拖出来的事故 | 否 | 本机 |

最强的几家（1Password+Browserbase、Skyvern、Operator）有共同点：

- 模型只拿引用；
- 由确定性代码在浏览器边上按网站填写；
- 填写时截图暂停或打码；
- 先复用登录态，过期才再填密码；
- 能不托管就不托管；
- 每次使用都有记录。

**Mikka 要无人值守地复用密码，就必须托管，做不到零知识。** 1Password 和 Bitwarden 的零知识
都需要用户在场解密，无人值守的云端分身做不到。所以目标是**把「谁能解密」收窄到一个组件**，
对外也不能说「连我们都看不到」。

## 3. 推荐方案

### 加密：信封加密（envelope encryption）

- **KEK** 放在云 KMS 里，推荐 **AWS KMS**：每个 key $1/月，$0.03/万次。Vercel 用
  OIDC 联合到 IAM role，不放静态密钥。
- **每条凭据一个 DEK**（`GenerateDataKey`），用 AES-256-GCM 在本地加密。AAD 和 KMS 的
  encryption context 都是 `{workspaceId, userId, credentialId, origin, purpose}`；key
  policy 用 `kms:EncryptionContext:*` 强制要求，CloudTrail 会记下 context。
- **权限分开**：主应用 role 只有 `GenerateDataKey`（能加密，不能解密）；**只有 broker role
  有 `Decrypt`**。
- 密文和 wrapped DEK 存 Neon。**Mikka 库里不出现明文**，Neon 泄露也解不开。
- 轮换用 KMS 自动轮换，无需重新包装。删除凭据就删行，DEK 随之作废。

不选其它方案的原因：

- **Infisical KMS** 只在企业版，加密接口不收 AAD。
- **#313 现有的「每条密码一个 Infisical secret」**：Infisical 是给应用配置用的，几百万条
  用户密码会碰上路径和权限面积、速率限制的问题，而且 Mikka 侧任何持有该 machine identity
  的进程都能读。
- **Vault Transit** 要自己运维集群。
- **Vercel KMS** 只能签名。
- **GCP KMS** 与 AWS 等价，也可以用。

Infisical 仍然用来放：broker 的配置（role ARN、日志指纹 pepper）、Secret Syncs、broker
的 machine identity，以及 API token 类凭据（Infisical Agent Vault 在代理层注入那种）。

> 需要 Alex 决定：新开 AWS 账号用 KMS（推荐），还是先沿用 #313 的 Infisical 存储作为第一版、
> 接口保持不变、之后迁移。`CredentialVault` 接口两种都能接。

### 数据表（Neon，新迁移，不是 #313 的三张表照搬）

- `credentials(id, workspace_id, created_by, origin, alt_origins[], username, auth_kind password|oauth|session, totp_mode ask|stored, unattended_allowed, created_at, last_used_at, revoked_at)`：唯一键 `(workspace_id, origin, username)`。
- `credential_secrets(credential_id, kms_key_arn, wrapped_dek, nonce, ciphertext, aad_version, created_at)`
- `browser_sessions(credential_id, wrapped_dek, nonce, ciphertext_storage_state, expires_at)`：cookie 也是凭据，同样加密。
- `credential_grants(credential_id, bot_id, scope, expires_at)`
- `credential_access_events(credential_id, bot_id, subagent_id, origin_seen, decision, ts)`：只记事件，不记值。

### 填写路径

1. 模型调用 `login(site)`。它只拿到 `credential_id` 或 `needs_login`，拿不到值。
2. 编排代码检查 grant，用 CDP 读顶层 frame 的 URL：协议加主机必须**精确等于**
   `credential.origin`。拒绝 userinfo URL，做 punycode 归一化，只认顶层，不认跨源 iframe。
3. 编排代码向 broker 要一次性 lease（约 30 秒，签名，绑定 subagent、origin 和目标）。
4. **broker 自己连分身浏览器的 CDP**，明文不经过 agent 进程。顺序如下：
   1. 暂停 screencast 和截图；
   2. 再核一次 origin；
   3. 按选择器聚焦输入框；
   4. 用 `Input.insertText` 写入（站点需要按键时退回 `dispatchKeyEvent`）；
   5. 清空 buffer；
   6. 跳转后或输入框清空后才恢复 screencast。
5. 防泄露：
   - 给模型的 DOM 快照去掉 input 的 `value`；
   - CDP、Sentry 等日志层丢弃 `Input.*` 参数；
   - 用 HMAC 指纹扫描日志和聊天记录，发现密码就拒绝写入。
6. 登录成功后加密保存 storage state；下次先试登录态，过期才再填密码。

### 其它

- **Google / Apple 按钮**：不收 Google 或 Apple 的密码。点了以后，分身点网站自己的「使用
  Google/Apple 登录」，用户在实时画面里自己完成授权：只给用户看，模型不接收任何画面，
  完成后保存登录态。Google 可能拦截自动化浏览器，要实测。
- **2FA**：默认用同一张卡片的验证码形态问用户。存 TOTP 种子必须用户明确开启，并且单独加密，
  因为种子和密码放在一起就等于只剩一个因素。
- **批准**：某个 bot 第一次在某个站点用某条凭据，要用户批准；之后只有用户开了「无人值守」
  才自动用。每次自动填写都发通知，并在设置里留记录。
- **设置**：设置里新增「已保存的登录」，可删除；删除即作废 DEK 和登录态。
  这一页属于 R-70 意义上的设置，先例是 1Password 和 Chrome 的密码管理器。

## 4. 威胁模型

| 威胁 | 防护 |
|---|---|
| Neon 泄露或备份泄露 | 只有密文和 wrapped DEK，解密要 KMS 的 IAM 权限。**防得住** |
| Next.js 应用服务器被攻破 | 应用 role 不能 Decrypt；只能为运行中的分身、在匹配的 origin 上申请 lease，有限速和审计。**部分防住** |
| 对模型的提示注入 | 模型拿不到值；origin 校验挡住填到别的站。**防不住**：分身在已登录会话里被诱导乱操作（Comet 事故） |
| 钓鱼或仿冒域名 | 精确 origin 绑定，broker 填写前再核一次 |
| 内部人员 | role 分离，CloudTrail 记录 context，broker 部署和 KMS policy 双人审批。**防不住**：恶意的 broker 部署 |
| 日志、截图、遥测泄露 | 暂停 screencast、去掉 value、丢弃 CDP 参数、指纹扫描 |

仍然不受保护的：

- broker 和 KMS role 能解密全部数据，因此不是零知识；
- 真网站本身的 XSS，或者被攻破的 E2B 沙箱、Chrome，能读到输入框；
- 被盗的 cookie 可以绕过密码和 2FA；
- 被劫持的分身能以用户身份操作，只能靠关键操作逐项确认（付款、删除、取消订阅等）；
- 存了 TOTP 种子后，2FA 只剩一个因素；
- 用户直接在聊天里打出的密码：要先检测，在送进模型之前打码；
- 网站更换登录域名时，`alt_origins` 放得太宽会削弱防钓鱼。

## 5. #313 里的密码箱代码：怎么救

#313（`integration/auth-r0-main975ee`，基于 main `975ee7a`）里有 #223 的
`lib/credentials/*`、`app/api/credential-requests/*`、`app/api/cron/credential-cleanup`、
`drizzle/20261025052200..02_*.sql`、`packages/daemon/src/agents/credential-bridge.ts`，
以及 `docs/credential-backend.md` 和 `docs/credential-verification.md`。

**可以直接留用**

- 提交接口的防护：精确 Origin、`X-Mikka-Credential` 头、拒绝跨站、12 KB 上限、拒绝
  CR/LF/NUL、`no-store`、nonce 一次性。
- 不存值、不记明文错误的纪律，「provider 错误不带 cause」的写法，以及清理和重放的测试。
- `CredentialVault` 接口（put/read/remove）。把实现换成 KMS 信封加密：`read` 只在 broker 里可用。
- 只有引用的 AI 工具：没有 `getSecret`。
- Infisical universal-auth 的取 token 逻辑：broker 读配置时用。

**必须按新方向改**（这三处与 R-72 冲突）

1. **不绑 run。** 现在每个请求都要 `workspaceId + runId + taskId`，还要设备在线；网页分身不是线程。
   改成按 `workspaceId + origin + username` 存；使用时绑定 `botId + subagentId`。
   线程（coding agent）需要 API token 时仍可按 run 申请，那条路径留着。
2. **默认保存、可复用。** 现在是 `retention: once | session`，到期就销毁。改成长期保存，
   支持撤销和删除，并加上 `browser_sessions` 复用。
3. **填进分身自己的浏览器。** 现在是独占的 `owned-chromium`，网站要在部署里预先登记，
   之后只能做固定的 navigate/read/click。改成 broker 连 bot 机器上该分身的 CDP 上下文，
   填完把浏览器交还给分身自由使用。预登记的 `services` 列表去掉，改用 origin 绑定。

**怎么拆**：不要在 #313 这个 592 个文件的 PR 里做。从最新 main 开一个只做密码箱的 PR，
从 `codex/issue-180-credential-backend` 或 #313 里拣上面「留用」的文件过来。#313 其余部分
（BYOS、Factory、self-improvement、权限）另外处理。注意 main 在 `975ee7a` 之后又合了简报、
Coordinator attention（#339）等，`lib/coordinator`、`workflows/coordinator` 会冲突。

## 6. 验收（沿用 #180 的完成门槛）

- 在 Preview 上，用一个**测试站点和测试账号**走完：药丸 → 卡片 → 保存 → 填写 → 分身继续 →
  第二次自动登录（先试登录态，再试密码）→ 设置里删除 → 再用就被拒。截真实界面图。
- 检查数据库、日志、聊天记录、SSE、截图、遥测、模型输入，全部没有明文；故意走错误路径也要查。
- 错误的 workspace、bot 或 origin，过期或重放的 lease，userinfo 或 punycode 仿冒的 URL，
  全部被拒。
- KMS 不可用时不能谎报成功；清理失败要可重试。
- 不碰生产数据和真实账号；生产迁移先走 manifest 检查。按 `AGENTS.md`，凭据只放在 Infisical。
- 交付时写明：分支、commit SHA、Preview URL；分别列出通过、失败、阻塞、未执行的项。

## 7. 主要来源

- 1Password × Browserbase：<https://browserbase.com/blog/browserbase-is-partnering-with-1password-for-agents/>
- Skyvern credentials：<https://skyvern.com/docs/cloud/managing-credentials/credentials-overview>
- Browser Use sensitive data：<https://docs.browser-use.com/open-source/examples/templates/sensitive-data>
- OpenAI agent takeover：<https://help.openai.com/en/articles/11752874>
- Manus cloud browser：<https://manus.im/help/cloud-browser>
- Comet × 1Password 事故：<https://the-decoder.com/a-calendar-invite-is-all-it-took-to-hijack-perplexitys-comet-browser-and-steal-1password-credentials/>
- AWS KMS encryption context：<https://docs.aws.amazon.com/kms/latest/developerguide/encrypt_context.html>
- Vercel OIDC → AWS：<https://docs.vercel.com/docs/oidc/aws>
- Infisical KMS encrypt API：<https://infisical.com/docs/api-reference/endpoints/kms/encryption/encrypt.md>
- 1Password 安全模型：<https://support.1password.com/1password-security/>
