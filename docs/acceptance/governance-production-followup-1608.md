# Organization owner 与审计生产补验

> **接线状态（2026-11-11 补记，必须读）：本文件描述的 workflow 接线尚未落地。**
>
> 原 PR #1856 把治理阶段接入 `self-hosted-production.yml`。该接线被 main 的
> `scripts/acceptance/memory-production-target.test.mjs` 挡住：它用 `assert.equal(secrets.length, 2)`
> 钉住「恰好两个 Infisical 读取步」，并用 `assert.equal(step.if, "<逐字节字符串>")` 钉住这两个步骤的
> `if:` 文本。放宽前者等于允许任意多个 workflow 读取生产凭据，属安全约束，不放宽。
>
> 因此本文件所描述的 selector 步骤、`governance_selection` id、六分钟/二十一分钟预算，
> **当前在 `self-hosted-production.yml` 中并不存在**，要由后续独立 PR 接线。
>
> **同时注意：本文档描述的 selector 语义绑定 #1856 自身的普通 merge**（`GOVERNANCE_PR = 1856`、
> `GOVERNANCE_BRANCH`、以及 `pr.merged === true && pr.merge_commit_sha === guard.applicationSha`）。
> 若 #1856 关闭而不再合并，该 selector 会永久 `decline('not_registered_followup')` —— 接线前必须先决定
> 这条 PR 的身份如何承接（例如改为绑定接线的后继 PR 编号，并一并更新 marker 前缀与测试）。
>
> 本文件保留规格价值：来源/窗口证明条件、marker 字段合同、清理证明与预算分段仍然有效。

本文供 #1608 / #1642 的发布负责人核对 PR #1856 的正常 Organization owner API 补验。它定义允许执行的来源、资源范围和清理证明；生产是否通过，以绑定具体 merge、run、attempt 的回执为准。

## 范围与前提

Alex 明确要求使用测试账号验收生产接口。原 Team owner 撤回了尚未执行的 v5.2 生产阶段，接续范围记录在 [#1608 的补验认领](https://github.com/alexj11324/Mikka/issues/1608#issuecomment-6757965328)。原隔离 PostgreSQL、HTTP 和先前生产回执继续归各自的来源。

补验使用 Infisical `prod:/` 的 `SMOKE_OWNER_EMAIL` 与 `SMOKE_OWNER_PASSWORD`，正常登录共享测试账号。既有 `selectAcceptanceTeam` 按既定管理员的身份指纹唯一识别测试团队，并验证测试账号的实际成员身份；这不代表测试账号拥有该团队的管理员权限。本次业务保持该 Acme 团队上下文。其他 workspace choices 只供既有团队选择器验证身份，不因此取得额外治理业务范围。

允许处理的业务资源是本次随机 nonce 创建、当前测试账号为唯一 active owner、没有 Workspace 绑定、没有身份提供方或 SCIM connection 的空 Organization。创建逻辑的套餐默认值来自绑定版本的服务和 schema；Organization HTTP summary 没有 plan 字段，回执不得声称从该响应读到了套餐。

本阶段覆盖正常创建、列表、详情、改名、默认策略读取、identity 读取、真实审计导出与分页，以及精确归档清理。它不创建 Workspace、成员、套餐授权、身份提供方或 SCIM 凭据。Pro 正向用量、Enterprise 配置、真实 OIDC / SAML 往返、SCIM 生命周期和多 Workspace 组织治理仍按各自的实际前提与结果记录。有限范围的成功回执保留 `fullEnterpriseAcceptance: false`。

## 执行入口

[Core 工作流](../../.github/workflows/self-hosted-production.yml) 复用成功 Web 发布的 `workflow_run` 入口和现有 `production-smoke-owner-acceptance` 队列，保留 `queue: max` 与 `cancel-in-progress: false`。治理阶段有独立 selector、步骤和登录会话，排在 Inbox 业务之前。原 Inbox inventory、fixture、步骤名称与恢复验证保持自己的范围。

治理 selector 在秘密读取前执行。仅它选中时，现有两项 Infisical 读取条件才为治理步骤成立。Core 和 Inbox 的原选择条件继续独立计算；关闭这些 issue 不会被伪装成可读的 Core attestation。工作流不增加身份、凭据种类、写权限或手动 dispatch。

治理步骤最多六分钟。驱动将最多 330 秒分为：业务 180 秒、Organization 清理 75 秒、旧会话撤销 15 秒、恢复 Workspace 30 秒、登出与旧 cookie 拒绝核验 30 秒；每段使用独立的截止时间，组织清理耗时不能占用后面的会话收尾预算。余下 30 秒供进程与回执收尾。工作流的总预算由十五分钟增加至二十一分钟，以容纳这个独立步骤；原 Core 和 Inbox 的单步时限不变。

## 来源和窗口证明

治理 selector 独立核对以下条件：

- 官方 Core workflow 的真实 main `workflow_run`、driver run / attempt、同仓库事件与成功 Web 发布。
- 实际 main、driver source 和公开 `/mikka/api/version.build` 指向同一提交；Web 的真实 attempt、deploy job 和关键发布步骤全部成功。
- PR #1856 的实际普通 merge 就是该 source，第二父为其精确 head，base 为 main，分支为 `fix/backend-production-followup-1608-1820`。
- 实际第一父链在 64 次读取内到达 #1831 的 merge `08327db0f3e7b78fc296f82232ecf0afda6ecd5b`。原 #1831 metadata、普通 merge 和 head `738f8d68ad2bfe77f180c6f52c27e881bd4674bd` 也必须匹配。
- 父 issue #1608 仍 open；已经关闭的子 issue #1642 不代替这个 gate，也不要求 Inbox issue 保持 open。
- #1752 中存在本 owner 的最新、唯一、精确绑定且未到期的治理 marker。

治理 marker 的前缀是 `mikka-governance-followup-1856`，字段合同如下：

| 字段 | 绑定 |
| --- | --- |
| `schema`, `state`, `issue` | `1`, `active`, `1608` |
| `pr`, `branch` | `1856`, `fix/backend-production-followup-1608-1820` |
| `headSha`, `sourceSha` | 实际 PR head 与普通 merge |
| `originPr`, `originMergeSha`, `originHeadSha` | #1831 与本节记录的原 merge / head |
| `startsAt`, `expiresAt` | 最多 120 分钟的实际执行段 |
| `phase` | `owner-audit` 或 `cleanup` |
| `recovery` | 仅 cleanup 阶段需要的已完成原 job 与精确 journal 引用 |

开始前登记真实的开始时间与最晚结束时间，然后重新读取所有新窗口和运行中的发布。普通 merge 后把实际 source 写入 marker。每次新业务写入都重新验证来源和窗口；marker 被编辑、替换、释放或过期，或 main / 公开版本变化，都会拒绝后续业务。已经选中的路径失效后不能回退到另一入口。

## 正常业务与精确清理

按以下顺序执行本轮资源的业务：

1. 正常登录并核对共享测试身份，保存原 Workspace 与本次会话指纹，再验证所选测试团队。
2. 读取 Organization baseline，并在首次创建前持久化包含 nonce、owner 指纹、source、run 和 attempt 的创建 intent。
3. 只发送一次创建请求。用正常列表和详情核对新 UUID、nonce、创建时间、创建者、唯一 active owner 及零 Workspace 绑定，再读取 identity 确认没有 provider / SCIM connection。
4. 改名并读取精确结果；读取本 Org 的默认 policy 与 identity。
5. 创建本 Org 的审计 export manifest，并按该 manifest 读取两页。核对 Org、manifest、事件绑定、计数与摘要，确认本轮真实事件；不把其他 Org 的历史数据作为样本。
6. 进入 finally，按本轮绑定执行 archive，验证正常 DELETE 的 `archived: true` 和 active owner list 对该 UUID 的精确缺席。
7. 恢复原 Workspace并读回，正常登出，再使用原 cookie 验证禁缓存 get-session 已拒绝；清空内存中的凭据与 cookie。

创建响应丢失时，不重发创建。正常 owner list 只能认领 baseline 外、精确 nonce 匹配的唯一候选，随后仍须详情和 identity 验证。零候选不能立即证明一个传输结果不明的创建未发生；该 intent 保留为 unresolved。遇到同名历史资源、多个候选、非本人 owner、额外成员、Workspace、provider 或 connection 时，不归档这些资源。

清理不依赖旧业务窗口仍有效，但其写范围只有本轮持久绑定的 Organization archive、保存的 Workspace 恢复和自己的会话退出。归档后仅得到详情 403，或仅有一侧删除响应，都不能代替完整清理证明。产品会保留组织审计与 tombstone；短期导出 manifest 按既有时限过期，回执不声称物理删除了全部审计数据。

cleanup-only 恢复只接纳同 source、同 workflow run 的更早 attempt。读取已完成的精确 job / step，核验 journal 摘要和闭集字段，再以正常 owner API重新验证本轮资源。旧 session 只通过记录的指纹在内存中精确匹配和撤销；cookie、token、邮箱和原始响应正文都不进入 journal。该模式不创建资源、执行新的业务或标记业务通过。

## 验证与回填

离线 guards 与现有 Core / Inbox guards 在同一工作流执行，覆盖拒绝错误来源或窗口、秘密读取顺序、独立 issue gate、创建响应丢失、历史资源不可认领、过窗清理、归档完整性、可信原件恢复，以及自己的会话退出。新增 source 同样匹配现有 `self-hosted-production*.mjs` 路径触发器。

生产回执保留精确来源、run / attempt / job、版本读回、逐项业务结果、HTTP status、固定错误码和逐项 cleanup。未知错误正文不直接输出；清理未闭合即失败。有限 Org / audit 范围通过与全 Enterprise 验收是两个不同字段，未观察到的权限、计划或外部服务前提保持未覆盖。

将实际结果分别回填 #1608、#1640 和 #1642。等待本次 merge 自动触发的 E2B / R7 终态，读取其实际原因和清理证据；同输入去重跳过不能记作订阅通过。完成本轮精确清理后立即在 #1752 释放实际窗口。
