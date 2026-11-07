# Enterprise v1 验收与发布范围

对应 [#1608](https://github.com/alexj11324/Mikka/issues/1608) P2，后端 PR [#1642](https://github.com/alexj11324/Mikka/pull/1642)。本文件记录证据边界和既有接口的验收步骤，不引入新的产品范围、付费 IdP、认证承诺或生产数据操作。

## 采用的验收边界

#1608 的 Enterprise 必过验收明确允许：“无企业环境的测试采用隔离的标准兼容 IdP/SCIM fixture 加可复现运行记录，不伪造生产客户接入成功。”因此，真实执行密码学、HTTP、事务和撤权的隔离 fixture 可以作为 v1 的协议验收依据。没有客户 IdP 配置，不构成额外采购要求，也不能被写成已经完成客户生产接入。

生产范围遵循 [最新 AGENTS](../../AGENTS.md) 和 [验收规范](../acceptance.md)：本地可测试的业务在隔离环境验收；部署后确认精确版本、迁移与自动 smoke，只有本地无法验证的真实外部服务才另做生产验收。生产操作只使用共享测试账号及 Acme Inc.，不使用 Alex 账号。

## 固定版本证据

已验证候选：[`ace63a1a0bff58540a5f56213878237b353d5cea`](https://github.com/alexj11324/Mikka/commit/ace63a1a0bff58540a5f56213878237b353d5cea)，tree `e69bc9ac414baa7966c315f68d190d821706651b`。环境为已授权 Docker Medium、Node 24.22.1、PostgreSQL 17 独立 loopback 数据库；源码先从公开 GitHub fetch 固定 SHA，没有上传未公开源码到沙盒。

- `pnpm exec tsrs --noEmit` 通过。
- `REQUIRE_DB=1 pnpm test:enterprise-db`：**29/29，0 skip**。其中 Organization 服务/数据库套件 13 项、协议 HTTP 套件 16 项；计数包含父测试。
- `ace63a1a` 的 GitHub Desktop workflow 已完成 frozen install、全迁移、完整 Web 后端构建及 Desktop checks。[smoke job](https://github.com/alexj11324/Mikka/actions/runs/42381335533/job/128429450876) 在 Electron 启动前的 `desktop-links.db.test.ts` 失败：匿名分享的 Markdown props 和 HTML frame 均返回 404 而预期 200。旧 fixture 未写 Artifact 的 Workspace、且前例移除了分享者成员资格；公开 P0 `98f3710e` 已修正这两项前置并保留撤权拒绝断言。该定位不等于 smoke 已通过，完整 Desktop 与全库 CI 仍需合流后验收。
- `f01529a3` 的 Enterprise suite 为 28/28；`3c2d7230` 的 P1 席位 9/9、实际治理 HTTP 6/6、纯策略/协议 12/12、DB runner 28/28。它们是各自固定版本的证据，不替代后续合流 head。
- `ace63a1a` 的 P1 seats 8 个子测试通过，但父 fixture 清理因 PostgreSQL `42501` 失败，总计 8/9；不能记录为整组通过。

最新合流前正在补的 HTTP 用例尚未计入上述通过数：OIDC RP-initiated logout 的真实 OP 确认/退出、短期一次性回调、跨浏览器/组织/配置绑定、上游和 nonce/audit 故障；以及普通会话拒绝、真实 OIDC 会话允许 usage/CSV/template apply、暂停 Workspace 成员后再次拒绝。前者是当前独立补丁，后者等待 P1 合流。合流还需保留三处有效工作区门禁和 main 的精确 Profile 源筛选。

## Issue 要求 → 后端证据

| 要求 | 已实现和已证实 | 证据性质与边界 |
| --- | --- | --- |
| Organization 管两个独立 Shared Workspace；角色与席位去重 | 创建、改名、成员角色、最后 owner、绑定/解绑、归档；相同两个人在两个 Workspace 只计两席；Org admin 不能因组织角色读取 Workspace | `governance.db.test.ts` 调用真实服务和 PG；不是管理 UI 或所有 Org HTTP 路由的端到端证明 |
| 组织计费归属且不扣费 | Enterprise 运维 CLI 的独立 Node 子进程完成 preview/apply、并发 expected-plan、重复 no-op、降额保留成员和审计；绑定 Org 的 Workspace 拒绝本地 dormant grant | 真实 CLI/PG；没有调用 Stripe 或创建价格、订阅、收费对象 |
| OIDC 登录、账号绑定和会话 assurance | 真实 authorization/code exchange、PKCE、RSA JWT/JWKS；拒绝错误 issuer、签名、过期及错误 state；同邮箱个人账号必须持短期、一次性、当前会话同意才能绑定；不提升角色或自动加 Workspace 成员 | `http.db.test.ts` 本机 HTTP IdP + Better Auth 原生验证器；不是 Okta/Entra/客户生产互通认证 |
| SAML 2.0 登录与退出 | 独立 SP/IdP 密钥签名 AuthnRequest/assertion；POST/Redirect 的 SP 与 IdP SLO；签名、RelayState、过期、provider 绑定、关联和并发 replay 正反例；不注销无关 OIDC 会话 | 真实 HTTP、Samlify 和持久 verification；不是 mock hook。固定 SSO patch 保留库密码学实现 |
| SCIM Users/Groups 生命周期 | HTTP 创建/读取/更新/PATCH/删除、分页/过滤、ETag、并发重复、停用/撤销连接；Group 不授予 Workspace 权限；交付故障留 durable outbox，重试不重复身份和审计 | 真实 HTTP/PG 的受限 SCIM profile；不宣称覆盖所有供应商扩展或配置模板 |
| 离职、停用与现有资源撤权 | 两个 Org Workspace 的成员暂停、范围内 PAT 撤销、旧 bearer 拒绝；保留个人账户、其他 Workspace/Organization 身份；管理接口重试可完成后续交付 | 真实生命周期服务/PG；最终 Task/Factory/Artifact/MCP HTTP 组合回归仍与 P0/#1615 合流一起完成 |
| 组织策略不绕过现有源 ACL | 源资源 owner 请求、Org admin 批准/拒绝、拒绝不可被重播抹掉；即使已批准，Org admin 仍不能取得 Workspace 成员权限 | 真实 PG/服务；现有模型凭证、订阅、MCP 的调用点复用该策略，最终主链回归验证集成 |
| 身份配置与角色撤回并发 | 最终角色/许可/SSO 检查持 Org 行锁直到 Auth DB commit；DNS/发现与 audit/SCIM delivery 在锁外 | `98989e8b` 测试先准确失败，`ace63a1a` 修复后通过；通过 competing backend PID 观察实际阻塞 |
| 元数据审计、失败不丢、可授权导出 | 配置与 audit intent 同事务；故障重试只投递一次；登录审计失败不能发布 cookie/redirect；导出逐页重验当前角色和 tenant、摘要完整性、数量上限；legal hold/有效导出阻止清理；归档保留历史 | 实际认证事件、故障注入和 PG 导出/清理；不是外部 SIEM 接入或合规认证 |
| 基础隔离不受套餐控制；Community 核心保留 | Workspace 成员表仍唯一；Org 只是管理层；Cloud/license entitlement 独立于 ACL；个人和无 Org Workspace 不被强制 SSO 套餐门禁影响 | P1 政策/席位和 P2 拒绝用例；独立自托管部署尚未另作验收，不宣称连接 Cloud 才可运行 |

源码证据：[`http.db.test.ts`](https://github.com/alexj11324/Mikka/blob/ace63a1a0bff58540a5f56213878237b353d5cea/lib/enterprise/http.db.test.ts)、[`governance.db.test.ts`](https://github.com/alexj11324/Mikka/blob/ace63a1a0bff58540a5f56213878237b353d5cea/lib/enterprise/governance.db.test.ts)、[`protocol.test.ts`](https://github.com/alexj11324/Mikka/blob/ace63a1a0bff58540a5f56213878237b353d5cea/lib/enterprise/protocol.test.ts)。接口字段、依赖许可和迁移/回滚见 [Enterprise ADR](../design/decisions/2026-11-07-1212-enterprise-identity-and-audit.md)。

## 当前没有声称完成的事项

- 新 P0/P1/main/#1615 主链的完整 CI、可信 Reader 传播和上述新 HTTP 用例尚需在最终公开 head 验证。
- 管理 UI 的实现与本地生产构建截图由 Claude 会话独立交付；当前后端 PR 的接口交接不是 UI 验收证据。
- 没有连接真实客户或供应商 IdP。协议 fixture 直接建立隔离 provider 和域名验证前置状态；它不证明真实公共 DNS TXT 验证、外部 OIDC discovery、生产证书轮换和客户控制台配置已经执行。
- 固定版本 `ace63a1a` 的 OIDC 只有 Mikka 本地 `/api/auth/sign-out` 会话退出与审计。当前补丁增加 RP-initiated IdP `end_session_endpoint` 请求和回调，使用原生验证的 discovery、加密配置和一次性 verification；新增真实 HTTP 回归尚待公开版本执行，不能提前记为已通过。SAML 已验证的双向 SLO 仍是独立证据。
- 强制 SSO、break-glass 和安全配置后端均存在。当前证据包含 access-policy 规则和过期许可恢复限制；五分钟 fresh-session/十五分钟恢复期限的完整管理 HTTP 操作没有单独记录为已通过。
- Task/Factory/Artifact/MCP 的最终范围隔离依赖 P0 与 #1615 的真实回归；本文件不把直接 `enterpriseWorkspaceAllowed` 断言等同于整条 API 链已验。
- 没有外部 SIEM/DLP、专属地域机房、SOC 2/ISO 认证或已签订的 DPA/SLA 交付声明。

上述区分用于准确记录证据。#1608 已接受隔离标准协议 fixture；客户 IdP 未接入不是新增采购或 v1 协议发布 gate。

## 发布后按当前授权执行

1. 以最终 merge commit 记录 Web 部署 READY、实际生产版本和自动 post-deploy smoke。迁移只走既有构建/发布流程，不在生产手工执行 SQL。检查新增的 Workspace/Auth 两组迁移都已由该流程处理。
2. 共享账号登录只使用现有授权通道，工作区保持 Acme Inc.。本地已经验证的 CRUD、并发停用、审计故障、export 篡改和限额不再写入生产重复测试；也不为验收创建新的付费资源或临时企业数据。
3. 如果现有授权环境已配置企业测试 IdP，按下面对应的原接口完成真实外部互通；如果没有，用固定 SHA 的隔离协议记录完成 v1 验收，并在发布记录写明“未做客户生产 IdP 接入”。不要求用户新购买服务。
4. 真实外部互通只记录时间、部署 SHA、provider/operation 的不敏感标识、HTTP 状态及审计 correlation ID/摘要。不记录 bearer、Cookie、client secret、私钥、完整 assertion 或个人内容。
5. 合流后的 #1597/#1600 回归、Team 权益、Enterprise 后端、Claude UI 各自验收，并按 P0 → P1 → P2 的 PR 顺序发布。知识库/RAG 不进入完成条件。

## 已有企业测试配置可用时的外部互通步骤

以下是可执行的接口顺序，不表示这些企业配置或权限已经存在。当前子任务只获授共享账号和隔离沙盒，未获得或使用真实 IdP、DNS 控制台凭据。不得把“本子任务未获得”写成“用户没有”。

| 环节 | 需要复用的已有配置 | 执行与记录 |
| --- | --- | --- |
| 管理上下文 | 共享账号在现有 Organization/Acme Inc. 的有效管理角色 | `GET /api/organizations` 与 `/:id/identity` 读脱敏状态；不从 Org role 推断 Workspace 内容权限 |
| OIDC | 现有测试 client、公开 HTTPS issuer/discovery、client ID/secret、已注册 callback 和 logout redirect、可用测试身份 | 管理员 `POST /:id/identity` 的 `configure-provider`；按响应分别注册精确 `callbackURL` 与 `postLogoutRedirectURI`；域名验证后 `/api/auth/sign-in/sso` 完成实际登录；`POST /api/auth/sso/oidc/logout/:providerId` 先撤销本地会话，再按 `upstream` 结果决定是否跟随 OP URL；无 ID token hint 时由 OP 询问用户确认；回调只返回固定 sign-in |
| 域名证明 | 已授权测试域名的 TXT 管理能力 | 配置响应给出的 `_mikka-sso.<domain>` TXT 值通过既有私密通道交付 DNS；`verify-domain` 通过后再启用该 provider；不截图或公开一次性 proof 值 |
| SAML | 现有 IdP entity ID、SSO/SLO 地址、当前签名证书、NameID/属性映射；需要 SP 签名时复用受管证书/私钥 | 配置原生 ACS/SLO 精确地址；走 SP 发起登录及双方支持的 POST/Redirect SLO；记录成功和无关会话保留，不把 assertion 正文写入证据 |
| SCIM | 现有测试目录的 provisioning 配置，能把 `externalId` 映射到 OIDC `sub`/SAML subject | 使用 `rotate-scim` 一次返回的 endpoint/token 配置已授权测试目录；先读 `ServiceProviderConfig`/Users/Groups；停用/撤权和故障注入继续采用隔离验收记录，不对共享 smoke 身份重复进行生产破坏性测试 |
| 审计 | 已有管理角色与上述真实外部事件 | `POST /:id/audit-log` 建有界导出，`GET` 分页读取；验证 manifest/digests，仅保存脱敏元数据；外部 SIEM 不在本次测试路径 |

OIDC 原生应用会话退出与供应商的全局会话退出不是同一能力。新的 RP-initiated logout 将结果区分为本地完成、上游已请求、上游返回或失败；回调本身不能证明所有供应商会话都已终止。没有 `end_session_endpoint` 的 provider 明确只做本地退出。当前已记录的双向全局退出协议通过证据为 SAML SLO，新的 OIDC 通过数须在公开候选实测后补入；不宣称客户生产互通已验。
