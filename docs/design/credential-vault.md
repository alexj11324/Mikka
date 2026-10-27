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
5. 密码**绑在用户账户上**，不是一次性的：这个用户的所有线程（coding agent）和所有 bot 的网页分身
   都能调用，以后同一网站自动登录，不再问；用户可在设置里删除。
6. 浏览器**可以访问所有网站，不设白名单**，不预先登记站点。
7. 模型永远拿不到密码；日志、聊天记录、截图、遥测里都不能出现。

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

### 加密与存储：第一版用 Infisical（Alex 2026-10-27 定）

不需要新开 AWS。第一版沿用 #313 的 Infisical 存储，外面再加一层由 Mikka 自己做的加密：

- **存储**：每条密码在 Infisical 里存成一个 secret。项目和环境单独划出，比如 `prod:/user-credentials`；
  名字是随机 UUID（`MIKKA_CREDENTIAL_<uuid>`），不带用户、网站或账号名。这部分是 #313 的
  `InfisicalCredentialVault`。
- **包一层应用加密**：写进 Infisical 之前，先用 AES-256-GCM 加密。
  - 总钥匙 `CREDENTIAL_MASTER_KEY` 是 32 字节，放在 Infisical，**只同步给 broker**。
  - 每个用户的钥匙用 HKDF 派生：`HKDF(master, salt=user_id, info="mikka-credential-v1")`。
  - AAD 是 `{userId, credentialId, origin, v}`。
  - 存进 Infisical 的值是 `{v, nonce, ciphertext}`。
  - 读出来时，只能用调用方自己的 `user_id` 派生钥匙并校验 AAD；拿错别人的那条，会解密失败并报错。
- **只有 broker 能读**：Infisical 里只有 broker 的 machine identity 能读这个目录。主应用的身份
  只能写，或者完全不能碰，由 broker 代为写入。其它服务和 Secret Sync 都不同步这个目录。
- **删除**：删 Infisical secret，再删 Neon 里的行。Infisical 的版本和备份保留由 Infisical 管，
  逻辑删除不等于从备份里物理擦除。
- 代码里的 `CredentialVault` 接口（put/read/remove）保持不变。以后升级到云 KMS 时只换实现，
  上层不动。

**以后升级到 KMS（不在第一版做）**：AWS KMS 或 GCP KMS 做信封加密，每条一个 DEK，
encryption context 绑定 `{userId, credentialId, origin}`，主应用只能加密、只有 broker 能解密，
每次解密都留 CloudTrail 记录，总钥匙永远不出 KMS。触发升级的时机：用户量大到碰上 Infisical
的速率限制，或者需要「总钥匙不进任何进程」这一级的隔离时。Infisical 自带的 KMS 只在企业版，
而且加密接口不收 AAD，所以不考虑。

### 用户之间的隔离（必须做到）

Infisical 不知道 Mikka 的用户：所有用户的密码在同一个目录里，broker 能读全部。所以「A 拿不到 B 的
密码」要靠 Mikka 自己保证，下面六条都是硬要求：

1. **调用方身份由服务器认定。** 线程或分身发起登录时，服务器从「这个 run 或分身的 owner」
   得出 `user_id`，再用 `user_id + origin` 查 `credentials`。模型和前端只能说要登录哪个网站，
   不能指定凭据 id、代号或用户。不存在按 id 取凭据的工具或接口。
2. **代号随机、不外露。** Infisical 名字和 `credential_id` 从不返回给前端、模型、日志或 SSE。
3. **加密绑定主人**（见上一节）。代码哪怕拿错了别人的那条，也解不开。
4. **按个人账户隔离，不按工作区。** 同一工作区的队友也不能用彼此的密码；B 的线程用不了 A 的密码。
   这和「线程只有主人能读写」的权限一致。
5. **Infisical 权限最小化。** 只有 broker 的 identity 能读这个目录。Infisical 的读取审计日志
   要能和 `credential_access_events` 对账。
6. **越权测试。** 下面每一种都必须被拒，并且不泄露「这条存不存在」：
   - B 的线程或分身请求 A 的网站登录；
   - 伪造或重放 `credential_id`、lease 或代号；
   - 换一个工作区去请求；
   - 已删除的凭据。

   #223 已有的跨用户、跨 run 拒绝测试，要按「绑账户」的新模型重写。

剩下防不住的情况：Mikka 服务器连同 `CREDENTIAL_MASTER_KEY` 一起被攻破，或者 broker 的
Infisical 身份被盗用，这两种都能读到全部密码。所以 broker 的部署和权限要尽量收窄。

### 数据表（Neon，新迁移，不是 #313 的三张表照搬）

- `credentials(id, user_id, origin, alt_origins[], username, auth_kind password|oauth|session, totp_mode ask|stored, unattended_allowed, created_at, last_used_at, revoked_at)`：唯一键 `(user_id, origin, username)`。属于用户账户，不属于工作区或某个 run。
- `credential_secrets(credential_id, vault_ref, aad_version, created_at)`：`vault_ref` 是 Infisical 里的随机名字；值（应用层密文）只在 Infisical。
- `browser_sessions(credential_id, vault_ref, expires_at)`：登录态（cookie）也是凭据，同样加密后存在 Infisical。
- （不设 per-bot grant 表：账户下的所有线程和分身都可调用，靠 access_events 审计。）
- `credential_access_events(credential_id, user_id, bot_id, run_id, subagent_id, origin_seen, decision, ts)`：只记事件，不记值。

### 填写路径

1. 线程里的 coding agent 或 bot 的网页分身调用 `login(site)`。它只拿到 `credential_id` 或 `needs_login`，拿不到值。
2. 编排代码确认调用方属于凭据的主人（run 或分身的 owner = `user_id`），用 CDP 读顶层 frame 的 URL：协议加主机必须**精确等于**
   `credential.origin`。拒绝 userinfo URL，做 punycode 归一化，只认顶层，不认跨源 iframe。
3. 编排代码向 broker 要一次填写用的短 lease（约 30 秒，签名，绑定调用方、origin 和目标）。这是单次填写的授权，密码本身长期保存。
4. **broker 自己连调用方浏览器的 CDP**（分身在 bot 机器上，线程在自己的 thread 机器上），明文不经过 agent 进程。顺序如下：
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
- **浏览范围**：浏览器访问所有网站，不设白名单。唯一的站点检查是「某网站的密码只填进那个网站」
  （密码管理器的标准做法，防钓鱼页骗走密码），它不限制浏览。
- **调用**：保存后，账户下的线程和分身直接调用，不再逐次批准；每次填写在设置里留记录。
- **设置**：设置里新增「已保存的登录」，可以删除；删除时同时删掉密码和登录态。
  这一页属于 R-70 意义上的设置，先例是 1Password 和 Chrome 的密码管理器。

## 4. 威胁模型

| 威胁 | 防护 |
|---|---|
| Neon 泄露或备份泄露 | Neon 里只有随机代号，没有密码。**防得住** |
| Infisical 项目泄露 | 只有应用层密文，没有 `CREDENTIAL_MASTER_KEY` 解不开。**防得住** |
| 用户 A 拿到用户 B 的密码 | 见「用户之间的隔离」六条。**防得住**，除非服务器和总钥匙一起被攻破 |
| Next.js 应用服务器被攻破 | 主应用读不了 Infisical 那个目录，也没有总钥匙；只能为该用户运行中的线程或分身、在匹配的 origin 上申请 lease，有限速和审计。**部分防住** |
| 对模型的提示注入 | 模型拿不到值；origin 校验挡住填到别的站。**防不住**：分身在已登录会话里被诱导乱操作（Comet 事故） |
| 钓鱼或仿冒域名 | 精确 origin 绑定，broker 填写前再核一次 |
| 内部人员 | broker 身份单独管理，Infisical 有审计日志，broker 部署双人审批。**防不住**：恶意的 broker 部署 |
| 日志、截图、遥测泄露 | 暂停 screencast、去掉 value、丢弃 CDP 参数、指纹扫描 |

仍然不受保护的：

- broker（持有 Infisical 读取权限和总钥匙）能解密全部数据，因此不是零知识；
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
- `CredentialVault` 接口（put/read/remove）和 `InfisicalCredentialVault`：外面加上应用层加密（绑定 user_id），`read` 只在 broker 里可用。
- 只有引用的 AI 工具：没有 `getSecret`。
- Infisical universal-auth 的取 token 逻辑：broker 读配置时用。

**必须按新方向改**（这三处与 R-72 冲突）

1. **绑账户，不绑 run。** 现在每个请求都要 `workspaceId + runId + taskId`，还要设备在线。
   改成按 `userId + origin + username` 存在用户账户下；这个用户的**每个线程和每个网页分身**
   都能调用（调用时校验调用方的 owner 是该用户）。
2. **默认保存、可复用。** 现在是 `retention: once | session`，到期就销毁。改成长期保存，
   支持撤销和删除，并加上 `browser_sessions` 复用。
3. **浏览器访问所有网站，不设白名单。** 现在是独占的 `owned-chromium`，网站要在部署里预先登记
   （`services`），之后只能做固定的 navigate/read/click。去掉 `services` 白名单和固定动作；
   broker 连调用方自己的浏览器（分身或线程）的 CDP 填写，填完浏览器照常自由使用。
   只保留「某站点的密码只填进该站点」的检查。

**怎么拆**：不要在 #313 这个 592 个文件的 PR 里做。从最新 main 开一个只做密码箱的 PR，
从 `codex/issue-180-credential-backend` 或 #313 里拣上面「留用」的文件过来。#313 其余部分
（BYOS、Factory、self-improvement、权限）另外处理。注意 main 在 `975ee7a` 之后又合了简报、
Coordinator attention（#339）等，`lib/coordinator`、`workflows/coordinator` 会冲突。

## 6. 验收（沿用 #180 的完成门槛）

- 在 Preview 上，用一个**测试站点和测试账号**走完：药丸 → 卡片 → 保存 → 填写 → 分身继续 →
  另一个线程或另一个 bot 的分身直接用同一条密码登录（先试登录态，再试密码）→ 设置里删除 → 再用就被拒。截真实界面图。
- 检查数据库、日志、聊天记录、SSE、截图、遥测、模型输入，全部没有明文；故意走错误路径也要查。
- 别的用户的线程或分身来调用、origin 不匹配、过期或重放的 lease，userinfo 或 punycode 仿冒的 URL，
  全部被拒。
- 用户 B 的线程或分身请求 A 的网站登录被拒；伪造、重放、换工作区、已删除凭据都被拒。
  从 Infisical 里拿 A 的那条，用 B 的 user_id 解密必须失败。
- Infisical 不可用时不能谎报成功；清理失败要可重试。
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
