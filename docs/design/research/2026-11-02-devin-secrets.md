# Devin 的 Secrets 调研笔记

日期：2026-11-02。用途：设置里的「密钥与登录」/「密钥与环境」方案（[`2026-11-02-secrets-settings-plan.md`](2026-11-02-secrets-settings-plan.md)）。

方法：用 Firecrawl 搜索 `site:docs.devin.ai secrets` 和 `site:docs.devin.ai service users API key secrets scope` 找页面，再用 Firecrawl 抓了主页面。Firecrawl 抓回来的 HTML 带了约 300 KB 的站点配置，所以全文是读 Mintlify 给每页提供的 `.md` 源文件（同一个 URL 后面加 `.md`，内容和网页一样）。下面链接都是网页地址。

标注：**【原文】** 是文档原话或忠实转述，附出处；**【推断】** 是我从原文推出来的，文档里没写。

## 读过的页面

| 页面 | URL |
| --- | --- |
| Secrets & Site Cookies（主页面） | https://docs.devin.ai/product-guides/secrets |
| Blueprint reference › Secrets | https://docs.devin.ai/onboard-devin/environment/blueprint-reference#secrets |
| Create an org-level secret（v3 API） | https://docs.devin.ai/api-reference/v3/secrets/post-organizations-secrets |
| List org-level secrets（v3 API） | https://docs.devin.ai/api-reference/v3/secrets/organizations-secrets |
| Create Secret（v1 API） | https://docs.devin.ai/api-reference/v1/secrets/create-secret |
| Cloud Authentication with OIDC | https://docs.devin.ai/product-guides/oidc |
| Custom Roles & RBAC | https://docs.devin.ai/enterprise/security-access/custom-roles |
| Invite your Team | https://docs.devin.ai/product-guides/invite-team |
| API Authentication（service users） | https://docs.devin.ai/api-reference/authentication |
| MCP servers | https://docs.devin.ai/work-with-devin/mcp |
| Integrations overview | https://docs.devin.ai/integrations/overview |
| Release notes 2026 / 2025 | https://docs.devin.ai/release-notes/2026 · https://docs.devin.ai/release-notes/2025 |

## 1. 个人和组织怎么分

- **【原文】** 在 Settings → Resources → Secrets 加的是持久化的组织密钥，“apply to the entire organization”，对组织以后的所有会话可用；“all members of your organization will be able to use Global Secrets, but only admins will be able to view or edit existing secrets”。[secrets#persisted-global-secrets](https://docs.devin.ai/product-guides/secrets#persisted-global-secrets)
- **【原文】** 个人密钥：新建时选 **Personal** scope；“only accessible in sessions you create and are not visible to other organization members or admins”。[secrets#personal-secrets](https://docs.devin.ai/product-guides/secrets#personal-secrets)
- **【原文】** 仓库密钥不在 Secrets 页，而在 **Settings > Environment > Blueprints › 仓库 › Secrets** 标签里（Create secret / Import secrets，可以搜索、显示、编辑、删除）。管理要 `ManageOrgSecrets`，“other members see the list read-only”。只在那个仓库的 blueprint 步骤和在那个仓库里工作的会话可用。[secrets#repo-specific-secrets](https://docs.devin.ai/product-guides/secrets#repo-specific-secrets)
- **【原文】** 会话密钥：Devin 在对话里向你要，或者你自己在会话里加；“scoped purely to the current session and are not saved for any future sessions”。[secrets#session-specific-secrets](https://docs.devin.ai/product-guides/secrets#session-specific-secrets)。2026-03-24 起，在首页新建会话时也能附带密钥。[release-notes/2026](https://docs.devin.ai/release-notes/2026)
- **【原文】** Enterprise 密钥会和组织密钥合并（2026-04-03 上线），“org secrets take precedence on name collisions”。只有 Enterprise 密钥可以标 **Build only**。[blueprint-reference#secrets](https://docs.devin.ai/onboard-devin/environment/blueprint-reference#secrets)
- **【原文】** 2026-09-11 “Safer Secret Defaults”：非管理员新建时默认 **Personal**；新建或导入组织密钥时，要确认“everyone in your organization can use them”。[release-notes/2026](https://docs.devin.ai/release-notes/2026)
- **【原文】** 2026-10-09 “Secrets sheets”：New secret 和 Bulk add 改成 sheet 布局，“with clearer scope selection”。[release-notes/2026](https://docs.devin.ai/release-notes/2026)
- **【推断】** Alex 截图里顶部的「Secrets for ▾（Myself / 组织 / Service users）」在文档里没有写，是 UI 里的筛选器。按上面几条，它是在同一页上切换看哪个范围的列表；新建时的 Scope 才决定存到哪里。

## 2. 谁能看、谁能改

- **【原文】** 组织密钥：成员可用；只有管理员能查看和编辑已有的（secrets 页）。
- **【原文，和上一条冲突】** Invite your Team 写 Member “can … view and contribute to most of your organization's resources, such as knowledge, playbooks, secrets”。[invite-team](https://docs.devin.ai/product-guides/invite-team)。Custom Roles 里有 **Manage Secrets**（“Create/edit/delete organization secrets”），默认 Member 角色“manage most day-to-day organization resources (such as … secrets …)”。[custom-roles](https://docs.devin.ai/enterprise/security-access/custom-roles)
- **【推断】** 两处文档版本不同。现行做法应该是 RBAC：有没有 `ManageOrgSecrets` 决定能不能改；没有的人只能读元数据。值不能读，见 §4。
- **【原文】** API 返回的元数据：`secret_id`、`key`、`note`、`secret_type`（`cookie | key-value | totp`）、`is_sensitive`、`access_type`（`org | personal`）、`created_by/at`、`updated_by/at`；“Does not return secret values”。[v3 create](https://docs.devin.ai/api-reference/v3/secrets/post-organizations-secrets) · [v1 list](https://docs.devin.ai/api-reference/v1/secrets/list-secrets)
- **【原文】** 2026-08-21：Enterprise 密钥可以原地替换值。[release-notes/2026](https://docs.devin.ai/release-notes/2026)

## 3. Agent 怎么引用和注入

- **【原文】** “Devin provides each secret to the specific commands and tools that need it. In the browser, Devin types the value directly. For shell commands, it binds secrets as environment variables whenever needed.” 密钥不会导出到每个 shell；脚本要用哪个变量，要告诉 Devin。[secrets#working-with-secrets](https://docs.devin.ai/product-guides/secrets#working-with-secrets)
- **【原文】** 名字会被改成合法的环境变量名：非法字符换成 `_`；以数字开头的前面加 `_`；**同名的两个密钥变成 `MY_SECRET` 和 `MY_SECRET_2`**。（同一页）
- **【原文】** Blueprint 里用 `$MY_SECRET` 引用；构建时每一步之前注入，并从快照镜像里清掉。[blueprint-reference#secrets](https://docs.devin.ai/onboard-devin/environment/blueprint-reference#secrets)
- **【原文】** MCP 的 stdio 脚本里也可以用 `$NAME` 引用 Secrets，作为环境变量传进去。[mcp](https://docs.devin.ai/work-with-devin/mcp)
- **【推断】** Devin 的 Agent 本身（浏览器和 shell 工具）就能用密钥，不只是构建步骤。放到 Mikka，相当于 Bot 自己的工具也能用，不只限于 Agent run。

## 4. 打码（Redact / sensitive）

- **【原文】** API 字段 `is_sensitive`，默认 `true`。[v3 create](https://docs.devin.ai/api-reference/v3/secrets/post-organizations-secrets)
- **【原文】** 2026-04-24 “Sensitive Toggle”：Devin 向你要密钥时，可以选值是遮住（sensitive）还是可见，不再总是遮住。[release-notes/2026](https://docs.devin.ai/release-notes/2026)
- **【原文】** 2026-10-07：密钥里是私钥时，命令输出里逐行打码，只打印出一部分也会被遮住。（同上）
- **【推断】** Alex 看到的「Redact value」就是 `is_sensitive`：开着时值在界面和输出里都遮住；关掉的值可见，适合 `DEBUG=1` 这类不敏感的配置。这正好对应 Mikka 现有的 密钥（遮）/ 环境变量（不遮）两种类型。

## 5. 使用前审批

- **【原文】** 文档、API（`SecretCreateRequest` 只有 `type, key, value, note, is_sensitive`）和 2025、2026 两年的 release notes 里，都**没有找到**“Require approval before each use”。
- **【推断】** 可能是最近 UI 新加、文档还没写的选项，也可能是 Enterprise 才有。行为没有出处，Mikka 不应该照着猜。要等 Alex 截一张图，或者确认我们自己要不要。

## 6. 网站登录怎么存、怎么用

- **【原文】** Devin 没有专门的“网站登录”类型。做法是：给 Devin 开一个专用账号；用户名和密码存成两个 Raw secret（例如 `GITHUB_USERNAME` / `GITHUB_PASSWORD`）；浏览器里由 Devin 直接输入。[secrets#giving-devin-credentials](https://docs.devin.ai/product-guides/secrets#giving-devin-credentials)
- **【原文】** **Site Cookies**：用浏览器扩展导出 cookie，存成 base64 编码、`;` 分隔的 chromium cookie JSON；之后 Devin 打开那个网站就已经是登录状态。有时还要再存用户名和密码。2026-03-24 起有 Cookie JSON 构建器（直接粘 JSON、校验、预览、过期提醒）。[secrets#adding-a-new-site-cookie](https://docs.devin.ai/product-guides/secrets#adding-a-new-site-cookie)
- **【原文】** **TOTP**（One-time Password）：上传 2FA 二维码截图；只建议给 Devin 专用账号用，不建议给个人账号。[secrets#adding-a-new-totp](https://docs.devin.ai/product-guides/secrets#adding-a-new-totp)
- **【推断】** 和 Mikka 比：Mikka 的密码箱更严。站点绑定，broker 填表，模型永远拿不到密码，登录后自动保存会话，不用用户导出 cookie。所以 Mikka 用一个「网站登录」类型（站点 + 账号 + 密码 + 可选 TOTP）比 Devin 的三个零散类型更好；cookie 类型不做。

## 7. Bulk add / .env

- **【原文】** Settings > Secrets 有 Bulk add sheet（2026-10-09）；导入时按行报错（2026-07-10）；导入时校验名字；Enterprise 仓库密钥也能批量导入。[release-notes/2026](https://docs.devin.ai/release-notes/2026)
- **【推断】** 「粘贴 .env、`KEY=value # note`、上传文件、最大 2 MB」这些细节文档里没有，来自 Alex 看到的界面。按 Alex 的描述做。

## 8. Service users

- **【原文】** Service user 是非人类身份，用于 API 和 CI；按 RBAC 给角色；组织级的可以管理“Session management, knowledge, playbooks, secrets”；可以带 `create_as_user_id` 代某人创建会话（需要 `ImpersonateOrgSessions`）。[authentication](https://docs.devin.ai/api-reference/authentication)
- **【推断】** 「Secrets for › Service users」是给 service user 发起的会话用的密钥。Mikka 没有 service user 这个概念（最接近的是个人访问令牌，还没上线），**不做**。

## 9. OIDC

- **【原文】** 每个会话自动拿到一个短期身份令牌（claims 有 `org_id`、`devin_id`、`requesting_user_email`），云厂商验证后换成临时凭据；“nothing to rotate or revoke”；在 blueprint 的 `initialize` 里用 `setup-aws-oidc` 等 action 配置。[oidc](https://docs.devin.ai/product-guides/oidc)
- **【推断】** 这是“少存密钥”的方向，和这次的设置页无关。Mikka 的 run 将来可以签自己的 OIDC 令牌（`lib/credentials/oidc.ts` 已经给 broker 签令牌）。不放进这几个 PR。

## 10. MCP 密钥移到各 server 页

- **【原文】** 2025-07-28：配置 MCP 时可以直接新建并引用密钥。2026-05-08：MCP 密钥新建框里可以选 personal 或 organization。2026-09-16 “MCP Secrets Are Now Managed in the MCP Page”：Settings → Secrets 页上加了一条横幅，说 MCP 凭据已经移到各个 server 自己的页面，附按钮和文档链接。[release-notes/2026](https://docs.devin.ai/release-notes/2026) · [release-notes/2025](https://docs.devin.ai/release-notes/2025)
- **【推断】** 意思是：某个集成自己用的凭据放在那个集成的页面上，Secrets 页只放给 Agent 用的通用密钥。Mikka 已经是这样了（插件密钥在 `components/plugins/credential-dialog.tsx`，模型 API Key 在 模型与订阅），这次不要把它们并进来。

## 11. 对照我们的 4 个待定问题

| 问题 | Devin 怎么做 | 对 Mikka 的建议 |
| --- | --- | --- |
| ① 同名优先级 | **【原文】** 个人和组织之间不覆盖：同名都注入，后一个加 `_2` 后缀。只有 Enterprise 和组织之间有优先级（组织赢）。 | `_2` 会让脚本读错变量，不照搬。建议**新建时就拦住同名**：在“我的”页新建一个和工作区同名的密钥，显示「工作区已有同名密钥」并让用户确认；确认后运行时个人赢。这一点仍要 Alex 定。 |
| ② run 前审批 | **【原文】** 文档里没有。 | 先只给网站登录做（已有 `unattended_allowed` 列）。key-value 的审批等 Alex 给截图或拍板。 |
| ③ 个人密钥给不给 Bot 自己的工具 | **【原文】** Devin 把密钥交给“需要它的命令和工具”，浏览器里直接输入。**【推断】** 就是 Agent 本身在用。 | 两种都能做；先给 Agent run（注入点已有），Bot 自己的工具后面跟上。仍要 Alex 定。 |
| ④ 一个入口还是两个 | **【原文】** 一个 Secrets 页，新建时选 Scope（Personal / Organization）；仓库密钥在另一个页面（blueprint）。**【推断】** 顶部「Secrets for」是列表筛选。 | 改成**一个页面，顶部切换**「我的 / 工作区」（Alex 要 Devin 那样）。侧栏两个入口都打开这一页，只是默认停在不同的那一侧；仓库密钥在“工作区”一侧，用「范围」列和筛选区分。 |
