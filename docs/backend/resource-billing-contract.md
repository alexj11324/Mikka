# 资源计费合同（#1849）

本文面向实现、运营和验收 Mikka 计费的工程师，定义平台付款主体、Stripe 状态投影、账本、预算和跨客户端数据合同。产品权限以 [Issue #1849](https://github.com/alexj11324/Mikka/issues/1849) 为准；计费权限不能授予私人内容、凭证或设备的访问权。

## 账户归属

Organization 可以通过 `setOrganizationBillingAccount(actorId, organizationId, workspaceId)` 指定一个已附属 Shared Workspace 的现有账户。调用者必须同时拥有 Organization 管理权限及原账户、新账户的 Workspace 管理权限。Personal Workspace 不能被指定。指定或解除操作只改变后续平台资源的付款路由，不移动余额、客户、订阅或账单。

`resolvePlatformBillingAccount(workspaceId)` 返回 `{ organizationId, accountWorkspaceId }`。未指定 Organization 账户时，返回原 Workspace。组织角色本身不能成为读取 Workspace 私人内容的依据。Organization 管理员通过 `organizationBillingView` 读取管理元数据，不需要获得私人内容权限。

平台模型先在执行前固定付款账户，每个工具步骤再次验证授权。Organization 账户变更、显式个人点数共享撤销或者付款成员离队时，调用返回 `billing_authorization_revoked`，不能自动选另一个人付款。Workspace 数据库的配额租约固定组织绑定；APP 数据库中的个人共享授权行在写入用量预留时加锁。

没有 Organization 付款账户的 Shared Workspace 继续支持成员显式共享个人点数。单人成员数量、邀请状态和成员停用都不能隐式选择个人余额。指定 Organization 账户后，平台资源使用该账户，余额不足不会消耗历史个人点数共享。历史共享记录和余额保留。

个人 API Key、Claude Code/Codex Subscription、个人 E2B 和设备仍归个人或其明确记录的外部账户付款。`ExecutionAccountUsage` 保留原始 `amount`，增加 `lane`、`costMicroUsd: null`、`currency: 'usd'` 和 `chargedByMikka: false`。没有外部收据时，金额是 Unknown；用量时长和请求次数不能被换算为虚构的零费用。

## 套餐与兼容

Shared Workspace 的 `activeHumanLimit` 为 `null`。Personal Workspace 仍只能有一个 Owner。历史 `seatLimit` 和 Stripe `seats` 保留用于审计、兼容及回滚，不参与邀请、恢复成员或套餐容量决策。并发容量继续使用 Free 8、Pro 32、Enterprise 128 的既有规则。

`STRIPE_TEAM_PRICE_ID` 只识别历史订阅。它不能创建资源套餐 Checkout。历史价格的 Stripe 数量和收费条款保持原样；取消、改价或迁移真实订阅需要独立财务授权。

资源 Checkout 使用单独配置的 `STRIPE_TEAM_RESOURCE_PRICE_ID`，数量固定为 1。服务器从 Stripe 读取 Price 并验证以下合同：

| 字段 | 要求 |
| --- | --- |
| `id` | 与部署配置的 ID 相同 |
| `active` | 创建 Checkout 时为 `true` |
| `currency` | `usd` |
| `type` / `billing_scheme` | `recurring` / `per_unit` |
| `recurring` | 每 1 个月，`usage_type: licensed` |
| `metadata.mikka_billing_model` | `resource_v1` |
| `metadata.mikka_plan` | `pro` 或 `enterprise` |
| `metadata.mikka_monthly_points` | 0–100,000,000 的十进制整数 |

没有配置或者验证失败时，返回 `billingResourcePlanUnavailable`。不能用昵称猜测套餐、复用旧每席位 Price 或在应用启动时创建价格。年度计划需要独立的按月授额合同，不得把一年的付款误当成一份月度额度。归档 Price 不影响其已付费订阅的付款期间。

## Stripe 与 Entitlements 一致性

订阅与相关 invoice 事件先校验 webhook 签名，再由 `applyStripeEvent` 处理。订阅处理在 APP 数据库的账户锁内重新读取 Stripe 的权威 Subscription 和 Invoice，避免乱序事件快照恢复已经取消的订阅。

只有已识别的套餐、`active` 状态和已支付 invoice 的匹配价格行共同建立付费期间。有效期取匹配 invoice 行的服务期间和订阅项期间的较早结束时间。付款失败只能保留先前已支付的有效期，不能延长；`canceled`、`unpaid`、`paused` 或没有付费凭据的订阅不产生付费权限。

一个 APP 事务写入以下记录：

1. 幂等的 `stripe_webhook_events` 事件收据。
2. 保留历史字段的 `workspace_billing` 状态及递增 `billingRevision`。
3. 以 invoice ID 唯一标识的既有 `workspace_credit_grants` 套餐点数记录。
4. `billing_entitlement_outbox` 的待投递投影。

APP 提交后，`drainBillingEntitlements` 才打开 Workspace 数据库事务。Workspace 和 Organization 的既有 entitlements 表新增独立的 `billingPlan`、`billingExpiresAt`、`billingRevision`、`billingSubscriptionId` 列，不覆盖运营发放的授权或自托管 License。有效授权合并时选择有效来源中的最高套餐；自托管不接受 Stripe 投影。

Workspace 数据库不可用时 webhook 返回失败，Stripe 重试同一事件。重复事件仍执行 outbox 投递；已经写入的账本和审计不重复。Workspace 事务以递增 revision 拒绝旧投影，提交后 APP 才标记已送达。已经删除的 Workspace 不能因历史付款事件被重建。没有新增轮询器或常驻服务。

只指定的 Organization 账户能向 Organization 投影套餐。指定账户时复制的是同一 Workspace 数据库中的投影，不跨库假定原子事务。解除账户会清除组织的计费投影，独立的运营授权保持原样。

## 点数账本与结算

`workspace_credit_grants` 和 `hosted_usage` 继续是唯一平台点数来源和用量收据账本。迁移不更新历史金额、客户 ID、付款 ID、收据或余额归属。

套餐点数增加 `periodStart` 和 `expiresAt`。只为已支付的正常创建或续期 invoice 发放一次，不为更新产生的 prorations 重发月度点数。已过期的延迟 invoice 仍保留历史收据，但不能恢复过期点数。没有期限的历史套餐记录保持原值。

消费顺序是可用免费额度、有效套餐点数、购买点数。`hosted_usage.planMicroUsd` 和 `planAllocations` 记录每份套餐授额的真实消耗；每个结算 ID 只结算一次。购买点数不因套餐更新或到期失效。一个已开始的调用在期间边界后完成，仍可消费开始时有效的授额，不借用未来期间的点数。

未知的供应商成本继续保留 `unknown` 收据和预留，不能结算为零。实际成本超过预留时，真实收据和欠额必须保留，后续 admission 按剩余余额拒绝调用。

### 税费与退款

Checkout 显式保留 Stripe Managed Payments。购买点数以服务端定价的商品小计为准；Managed Payments 加收的税款保存在实际付款收据，不转换为额外点数。购买点数退款按累计实际退款金额与原始含税付款金额的比例，向原有账本追加负数记录；最后一笔全额退款扣回剩余授额，不因整数舍入多扣或少扣。

套餐授额保存 invoice 与实际 PaymentIntent 的分配关系，兼容历史单一 PaymentIntent 和当前 `invoice_payments` 多笔付款。`billing_refund_receipts` 是签名退款事件的持久收件箱，不是余额账本。退款先于 invoice 或两者并发时，提交后的有界对账会向 `workspace_credit_grants` 追加关联原授额的补偿行。原始付款、期间、用量及 Owner 均不变。

部分退款按原始实际付款比例撤销套餐点数。当前付费 invoice 完全退款时，该 invoice 对应的 Stripe 付费权益降为 Free；独立运营授权仍保留。已经发生的使用记录不撤销，不向另一账户或个人购买点数桶制造退款欠额。旧 invoice 或重复 webhook 不能恢复已经退回的额度及权益。Stripe 订阅本身的取消、客户余额调整或 Credit Note 的创建仍由独立、明确授权的财务流程负责；应用不会为完成对账而执行这些付款变更。

提交后对账与 outbox 投递每次最多处理 100 条；未完成的批次返回失败，由 Stripe 重试驱动，没有新增空闲轮询。送达标记必须同时匹配 event ID 和读取到的 revision，不能把并发生成的新退款投影误标为已送达。

## 自动充值的提供商边界

当前付款合同是 Stripe Managed Payments。其官方支持范围是 Checkout 和 Payment Links，不支持应用直接建立的 `off_session` PaymentIntent 或订阅期间之外的一次性 invoice。因此本批不伪造可执行的自动扣款入口，也不自动切换 Merchant of Record 或税务责任。

`AutoRechargePolicyView` 明确返回 `state: 'provider_unsupported'`、`enabled: false` 及已保存的阈值、单次金额、月度上限和 revision。现有计费界面显示不可用原因。`saveAutoRechargePolicy` 只允许当前 Workspace Owner，或指定 Organization 账户的当前 Organization Owner 保存限制、撤销旧设置；Admin 身份不自动成为付款授权。输入采用 revision 比较更新，单次金额限 1,000 / 2,500 / 5,000 点，阈值必须低于单次金额，月上限不得低于单次金额，操作留审计。

尝试启用自动充值必须显式同意，但在当前提供商合同下仍返回 `billingAutoRechargeUnavailable`，不会发出付款请求。历史 `autoRechargeEnabled` 不能视为变更提供商或新增扣款的授权。真实自动充值的实施与验收必须等受支持的提供商路径及新的明确财务授权；仅保存限制或通过合成测试不代表自动充值已完成。

## 预算与阈值

`setWorkspaceBudget(actorId, workspaceId, input)` 要求当前 Workspace 管理权限，支持以下输入：

| 字段 | 合同 |
| --- | --- |
| `scope` | `workspace`、`member`、`project`、`thread`、`run` |
| `scopeId` | Workspace ID、成员 ID 或资源 ID；必须绑定当前 Workspace |
| `period` | `month`、`day` 或 `lifetime`；日期边界为 UTC |
| `limitPoints` | 0–100,000,000；`null` 解除该限制 |
| `warningPercent` | 1–100；默认 80 |

Project、Thread 和 Run 的预算管理只查询 APP `resource_access_policies` 的权威绑定元数据。成员预算要求当前活跃成员。预算操作和 `billing.limits_changed` 审计在同一 APP 事务中提交。

`workspaceBudgetView` 返回 `spentPoints`（已结算）、`reservedPoints`（执行中或未知成本的预留）、`committedPoints`、`remainingPoints`、`thresholdReached` 和 `exhausted`。这些值来自原用量账本，不另建用量计费账本。

调用入口通过服务器的 `hostedBillingScope` 传入 `actorId`、`projectId`、`threadId`、`runId` 和 `attributionComplete`。只有授权和资源绑定验证完成后才设置 `attributionComplete: true`。存在较小资源范围的预算但缺少可信归属时，admission 拒绝执行，不能用空 ID 绕过预算。

`HostedUsageStore.reserve` 在原有平台和账户锁内检查已结算成本与所有在途预留，防止并发绕过 Workspace、Organization 账户或资源预算。旧的 `workspace_settings.monthlyCreditLimit` 继续生效。预算不足返回 `usage_budget_exhausted`，不能触发个人余额或付费模型回退。

预算 admission 要求剩余额度覆盖调用预留。供应商的最终成本仍以真实收据为准，因此预留不是供应商账单的上限；发生超额后账本如实保留，后续调用停止。BYO 外部 Unknown 费用不能假装进入平台点数预算。

## 迁移与回滚

本合同使用五份只增迁移：`20261110020030_billing_consistency.sql`、`20261110020031_billing_entitlements.sql`、`20261110020032_plan_credit_usage.sql`、`20261110020033_resource_budgets.sql`、`20261110020034_billing_financial_receipts.sql`。第二份用于 Workspace 数据库，其余用于 APP 数据库。

发布前保存部署 SHA 和数据库备份，并核对 `workspace_credit_grants` 的原记录数、各账户各桶金额总和、Stripe 客户/订阅 ID 及历史 `hosted_usage` 金额。发布后核对这些历史值保持不变，再检查增量授额和使用收据。

回滚保留所有新增列、outbox、授额和用量收据，不能删表、删列或反向移动余额。选择保留资源 ACL、个人付款隔离和 webhook 幂等修复的安全代码版本；若只回退界面，服务端付款和访问边界继续保留。回滚前按同一套数据库验收确认旧读取代码不会重新启用自动个人扣款或重扣已消费点数。回滚操作、目标 SHA、未送达 outbox 数量和重新投递结果写入对应 PR。

产生退款补偿行后，回滚版本必须保留 `parentGrantId` 关联退款的余额计算、退款收件箱及 outbox 投递逻辑。直接部署早期只读取正数套餐授额的代码会恢复已退额度，不是允许的回滚路径。需要回退其他功能时，应先将这些财务兼容修复移植到目标版本，再运行部分退款、全额退款和乱序投递验收；不能声称任意历史 SHA 可安全回滚。

## 验证依据

`tests/billing.db.test.ts` 覆盖付款期间、乱序 webhook、跨库投递失败后重试、旧订阅、显式 Organization 账户、套餐点数结算、部分/全额退款、多笔付款、退款先到和并发对账、Owner 自动充值限制与拒绝未支持扣款。`tests/billing-points.db.test.ts` 覆盖含税购买与退款的点数/实际金额分离。`lib/abuse/store.db.test.ts` 覆盖真实 PostgreSQL 的并发预算、未知成本预留、期间边界和账本幂等性。`tests/governance-seats.db.test.ts` 保留 Personal 边界、配额容量以及单连接池锁顺序验收。

上述数据库测试使用隔离数据库和合成 Stripe HTTP 响应，只证明应用和数据库行为。它们不等同于真实 Stripe、Claude Code/Codex、E2B 或生产验收。生产价格修改、真实扣款及不可逆余额转移需要另外的明确财务授权。

## 官方参考与 Mikka 决策

[Capy 计费文档](https://docs.capy.ai/admin/billing) 和 [模型与价格文档](https://docs.capy.ai/models-and-pricing) 描述 Organization 点数、容量及个人连接优先级。独立 Workspace 租户边界、历史余额不移动、双库 outbox、个人付款授权及预算数据结构是 #1849 的 Mikka 实施决定。

Stripe 的 [订阅 webhook 文档](https://docs.stripe.com/billing/subscriptions/webhooks) 将已支付 invoice 与有效订阅作为权限依据；[webhook 文档](https://docs.stripe.com/webhooks) 要求处理重复和乱序事件；[Invoice 对象](https://docs.stripe.com/api/invoices/object) 要求使用 invoice 行的服务期间；[订阅项期间变更](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end) 解释项级期间字段。本实现兼容项级期间及历史顶层期间，不以 webhook 到达时间作为付费期限。

Stripe 的 [Invoice Payment 对象](https://docs.stripe.com/api/invoice-payment/object) 和 [列表接口](https://docs.stripe.com/api/invoice-payment/list) 定义实际付款分配；[Managed Payments 文档](https://docs.stripe.com/payments/managed-payments) 列出当前不支持的集成，[配置文档](https://docs.stripe.com/payments/managed-payments/set-up) 定义 Checkout 的显式启用参数。这些是提供商能力边界；退款时保留已发生用量、追加补偿账目以及不在未知外部成本上扣点，是 Mikka 的财务归属要求。
