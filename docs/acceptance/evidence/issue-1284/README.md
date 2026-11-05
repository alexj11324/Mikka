# #1284 component visual review

These screenshots render the actual Agent Profile settings, editor and task selector in a Docker Cloud Sandbox production build with synthetic fixture data. They are component layout evidence only: no real account, credential, model call or final deployment acceptance is claimed. The fixture is outside the product repository and has no authentication or mutation API.

Captured 2026-11-05 UTC from the pre-rebase implementation working tree based on 2b25caad1608df6a2a54d5e18e798b3c9807ce89. Product UI source was later replayed onto fc2d401bde7b3f567b1288b01accd6fdeb433d0c. The PR records exact-head CI, isolated authenticated API acceptance and subsequent production acceptance separately.

Reviewed: desktop editor and dark list; 390px list/editor; default/empty and loading-error recovery; unavailable choices in the task picker. The 390px iframe has no horizontal overflow and retains save/cancel controls.

这些图片仅证明真实组件在虚构数据下的布局和状态。真实账号、CC/Codex 运行及最终部署版本的验收记录另见 #1284。


## Existing production subscription baselines (before Profile deployment)

On 2026-11-05, the existing authorized Owner used the existing Claude Code and Codex subscription connections. Each task produced an exact small text file, independently reviewed its committed contents, completed the legacy Verify stage, and was accepted through the normal Owner UI. These runs establish real native subscription connectivity only; they do not prove the Agent Profile feature or the new flowVersion 2 behavior.

| Route | Task | Actual model | File SHA-256 | Owner outcome |
| --- | --- | --- | --- | --- |
| Claude Code / claude_code_cli | ALEX-58 | claude-haiku-5-5 | 2e17c96148b6c268a52d6be7394c4b7ae8f32120933da541492ea7d42492ba4f | Accepted |
| Codex / codex_cli | ALEX-56 | gpt-6-luna | 759e95464752666d035734902a3b173cd35ce27b82cffe0a4407eaf5d484fc57 | Accepted |

Evidence: [CC identity](cc-baseline-identity.jpg), [CC accepted](cc-baseline-accepted.jpg), [Codex identity](codex-baseline-identity.jpg), [Codex accepted](codex-baseline-accepted.jpg), [structured baseline receipt](subscription-baselines.json).

The DeepSeek API path was explicitly excluded by the user because the account is unfunded. No balance probe or paid API execution was performed.

## 最终隔离构建与正常 HTTP 验收

提交 `5190c20497d1ffe2d7540def2c1fbf0d422448dc`、tree `c1b99368abf14055fc744ca4dbb1694b9f7a3e33` 在 Docker Cloud Sandbox Large（8 vCPU / 16 GiB、Node 24、PostgreSQL 17）完成完整 `pnpm build`，退出码 0。严格部署身份校验绑定同一 SHA 和 `http://localhost:3110`，使用正常 TestAccountPool 注册、登录，27/27 HTTP 断言通过。清理复核于 2026-11-05T02:04:53Z 确认租约、有效会话、预览及所属进程均为零。

[逐条 HTTP 验收脱敏收据](isolated-final-5190c204.json) · [最终回归与新增轮询规则核对](verification-summary.json)。收据经过现有 evidence audit；没有账号标识、密码、Cookie、令牌、私密 headers 或 descriptor 密钥。套件有覆盖重叠，不将不同套件数量累加成唯一测试数。

[PR #1297](https://github.com/alexj11324/Mikka/pull/1297) 的 exact-head [CI](https://github.com/alexj11324/Mikka/actions/runs/41952290490) 全部结束：27 success、5 按 PR 条件 skipped、0 failure。已 squash merge 为 `514030294dcdc68b2d9ca4a977ce04b298b37e6f`，保留合并时的最新主分支。此节记录隔离验收；最终生产 Profile 协作证据将在部署和真实执行完成后补充。


## First production attempt after #1297

The initial Web deployment and official runtime refresh both completed for `514030294dcdc68b2d9ca4a977ce04b298b37e6f` (worker `763970493d277fea13cef08e7f795f30de380d56`). This confirms deployment, not successful feature acceptance.

The zero-custom-Profile task ALEX-59 failed at dispatch with `Workspace membership lease unavailable or cancelled`. The expanded Owner UI tool result and production log agree; a separate normal UI `list_runs` call returned `[]`. The same failure was reproduced in Docker Large with real PostgreSQL by delaying model planning for 21 seconds, beyond the existing 20-second membership lease. A fix-forward patch is being validated without extending or bypassing the guard. No custom production Profiles have been created, and #1284 remains open.

- [Initial release receipt](./release-514030294.json)
- [First production failure and isolated reproduction](./production-first-failure-514030294.json)

DeepSeek API remains excluded by the user's instruction; no funded/API success is claimed.


## #1313 exact-source UI review (8608b63)

The follow-up batch includes #1307 UI changes. Nine manually inspected screenshots were produced from the real production components at `8608b63f522e6bbb8db8fc0caac7f606f17cf218` (tree `ff973ac99fea66a4d97a757c1475103363fb21c4`). Desktop and exact 390 × 848 CSS-pixel iframe layouts were checked in Docker Large; synthetic props only, no real account/API/model execution. The independent fixture and browser tab were stopped/closed after capture.

- [Visual report and nine screenshots](./issue1313-8608b63-visual-review.md)
- [Build, source-file hashes and screenshot receipt](./issue1313-8608b63-visual-receipt.json)

The original #1307 screenshots predated that PR's final head and are historical only. These captures cover the integrated follow-up UI. Later backend-only commits may reuse this layout evidence only after the recorded 11 relevant source files are byte-identical; the screenshot source remains `8608b63`.

CI for `8608b63` is not green: the real ten-way dispatch test exposed an additional pool checkout in Profile finalization. Docker reproduction confirmed the pool timeout precedes the cleanup deadlock. The batch remains unmerged while this transaction regression is repaired; the screenshots do not claim production acceptance.


## #1313 first integrated verification and CI regression

`8608b63` completed a clean full production build and 27/27 normal authenticated HTTP assertions. Profile PG 30/30 (including both 21-second planning waits), shared-subscription claims PG 28/28, related unit/component checks, schema/type/lint/diff gates passed. The two sanitized JSON receipts passed the existing credential/session evidence scanner. No suite totals are presented as a count of unique scenarios.

- [Exact-source build, HTTP, cleanup and evidence audit](./isolated-8608b63f.json)
- [Exact-source targeted gates](./gates-8608b63f.json)
- [CI failure and independently reproduced connection-pool timeout](./ci-first-failure-8608b63f.json)

These passing local checks do not override the failing CI concurrency suite. The same ten-way suite is the required regression for the fix-forward; later source and final CI evidence will be recorded separately. The original sandbox was resumed on 2026-11-05 after its configured one-hour deadline completed stopping; no substitute platform or new sandbox was used.


## #1313 second integrated verification (2bb08cda)

The transaction-pool fix was integrated with current main `caebc8e6`, including #1314 and #1326. GitHub and Docker shared the exact tree `d320f657ea99d8dc1af0046dd9f9da1d964538e9`. The source was clean before and after the isolated gates.

- [Pre-integration transaction checkpoint](./transaction-cb647188.json): original concurrency group 2/2, Profile PG 36/36, automatic dispatch 5/5 and continuity/watchdog 8/8.
- [Exact 2bb08cda targeted PG gates](./gates-2bb08cda.json): concurrency 2/2, Profile 36/36, automatic dispatch 12/12, continuity 8/8, shared subscriptions 34/34; zero failed or skipped. Typecheck, lint and diff checks passed. The suite counts overlap in purpose and are not a count of unique scenarios.
- [Exact 2bb08cda full build and normal HTTP acceptance](./isolated-2bb08cda.json): full `pnpm build` exit 0, 27/27 normal authenticated HTTP checks; no active test leases, valid sessions or app listener after cleanup. The existing evidence audit passed.
- [UI source identity proof](./ui-reuse-2bb08cda.json): all 11 relevant files match the actual 8608b63 screenshots. The image capture source remains unchanged.
- [Second CI failure](./ci-second-failure-2bb08cda.json): `test:factory-routing-db` failed in two caller-owned transaction fixtures with `factoryTransactionNotOwned`; the dependent build gate correctly refused to proceed.

The CI failure triggered a complete caller audit, which also found real unregistered transaction owners in self-improvement rehearsal, handoff and legacy evaluation fallback. These are being connected to the existing Factory lifecycle while preserving authorization, replay, rollback and after-commit behavior. The passing local checks above do not override this CI failure. #1313 remains unmerged and #1284 remains open pending a corrected head and real production Profile acceptance.


## #1313 corrected owner integration (c95f9a13)

The missing self-improvement transaction owners are now connected to the existing Factory lifecycle. The reviewed five-file patch preserves authorization, replay, immutable assignment, rollback and post-commit notification behavior; it does not change connection-pool limits or database-role permissions.

- [Original full routing suite and source gates](./owner-gates-a193-c95.json): **214/214**, zero failed/skipped/cancelled, plus type/lint/diff success. These ran at local checkpoint `a193faeb`; its Git tree is exactly the published `c95f9a13` tree `b57beda811396f6e29a318c72a27eeef4d63e124`. The actual execution SHA is preserved. Earlier owner, fixture-assertion and cleanup failures remain recorded.
- [Independent self-improvement red/green receipt](./self-improvement-c95f9a13.json): the same owner-contract assertions fail on 2bb08cda and pass **7/7** on exact published c95f9a13. All owned test roles/databases and processes were cleaned up.
- [Exact c95f9a13 full build and normal authenticated HTTP](./isolated-c95f9a13.json): `pnpm build` exit 0, **27/27** HTTP assertions, clean source, zero active test leases or valid sessions and no application listener after cleanup. Five sanitized receipts passed the existing evidence audit.
- [Exact-head CI](./ci-c95f9a13.json): [run 41968882317](https://github.com/alexj11324/Mikka/actions/runs/41968882317) completed successfully at 2026-11-05 04:42:52 UTC; **17 success, 1 expected OIDC skip, 0 failure**. All four database shards and the dependent build gate passed.
- [UI identity proof for c95f9a13](./ui-reuse-c95f9a13.json): all 11 relevant files still match the nine actual screenshots captured at 8608b63. The screenshot source is not relabeled.

The independent suite counts above are not added together as a count of unique scenarios. DeepSeek API remains excluded and `test:local-loop` remains unrun. This head is ready for the repository's coordinated batch process; no new production Profile acceptance is claimed yet. #1284 remains open until the original zero-config task and the real Claude Code → Codex Profile cases complete on the deployed production build.


## 最终整合批次 #1345：f4e0a991（生产验收仍待完成）

本节记录最终提交 `f4e0a99143ab924390e8fbd915455c4abc7e21cf`、tree `1fc7e470a4ce8fa6f8cbbb43951140306a7b2544`。GitHub merge candidate `636616f90868accb9afaff03a9259b7769a63e73` 的 tree 完全相同。

批次保留 #1313 原提交的祖先与全部关键产品文件；#1328 已由另一 owner 的 #1336 合入 main122，本批不重复认领其合并或验收。相对当前 main122，净改动为 #1313 的 17 个文件及工作流文档。前一生产版本的 [READY 与公网 SHA 记录](./release-main122-before-merge.json) 单独保留。

- [最终 CI](./ci-f4e0a991.json)：[41973672831](https://github.com/alexj11324/Mikka/actions/runs/41973672831) 成功；18 checks 为 17 success / 1 expected OIDC skip，四组数据库与所有依赖 gate 通过。
- [最终 Docker PG/静态检查](./gates-f4e0a991.json)：96/96、0 fail/skip/cancel，覆盖 policy-denials、Coordinator 十路并发、最终 Profile claim、共享订阅、Owner acceptance、真实 self-improvement 事务 owner、Issue live 关系和 chat deadline；types、相关 oxlint、diff 均 exit 0。自有角色和数据库正常清理，未使用 FORCE 或 terminate。
- [最终完整构建与正常 HTTP](./isolated-f4e0a991.json)：全新隔离数据库、严格部署标识、`pnpm build` exit 0、正常注册/登录和 Profile CRUD/隔离/历史/409/归档 **27/27**；清理后 active leases=0、valid sessions=0、3110 无监听。九份 JSON 通过仓库现有凭证/cookie 证据审计。
- [视觉复用审计](./ui-reuse-f4e0a991.json) / [说明](./ui-reuse-f4e0a991.md)：九张截图仍来自实际 8608 合成组件夹具；相关组件、样式、依赖与实际读取的 28 项翻译子树/键相同。locale 整文件已随主干变化，未声称整文件相同，也未把旧图改称新截图。
- [19a 整合审计](./integration-audit-19a7094c.json) 保留原本执行版本，不冒充 f4e0 的新测试。

### 19a 本地 routing 的两次清理失败

[首轮](./routing-19a-first-cleanup-failure.json) 与 [一次诊断复核](./routing-19a-diagnostic-cleanup-failure.json) 都保留 **209/210、1 fail、0 skip**，失败位于 fixture 的 `DROP DATABASE … WITH (FORCE)`，错误码 42501。首轮未记录目标 backend 身份；第二轮在错误前 2ms、后 24ms 的采样中，目标 owned 数据库仅剩 autovacuum worker，测试客户端已退出。没有第三次重试，没有加权限或改弱 helper。这两条本地红灯不改写为通过；最终全量 PG 门禁采用实际通过的 f4e0 CI，其他最终本地组的 96/96 另行记录。

上述组存在覆盖重叠，不累加为唯一场景数。DeepSeek API 仍按用户指示排除，`test:local-loop` 未运行。本轮测试服务和 PostgreSQL 已停止，Docker stop 已提交；部署与真实 Profile 生产验收尚待完成，#1284 继续保持 open。

## 零配置生产验收：ALEX-59（2026-11-05）

正常 Owner UI 已接受 ALEX-59 的零配置任务。06:00 UTC 的当前界面显示 **Accepted**；活动记录显示 `acme — Changed status to Done`。任务为 `feaefa0a-d826-49a2-b6bd-b02f55b267ce`，Issue ID 为 `dd7bc618-b7ae-4835-981e-acd3f233c3da`；观察到 2 条线程、一次独立 Review，没有单独 Verify 阶段。

### 版本时间线

- 任务在生产 **`f47326089aaddda1a7d668441e322265ebac8ea9`** 启动，tree 为 `1fc7e470a4ce8fa6f8cbbb43951140306a7b2544`。其 Main CI、Web、Vercel READY 与公开版本证明见既有 `release-f4732608.json`。
- Owner 接受时站点已经更新为 **`94f1b829300156af343751647d2417dde7373c6e`**（后续 #1351 批次）。Root 当时核对其直接父提交包含 f473。本证据保留这一版本变化，不把全部生产操作归到 f473，也不以 f473 的发布收据代替 94f1 的发布证据。
- 直接 UI 的接受时间观察到分钟级。随后正常 Coordinator 的只读工具总结给出 acceptance ID `d2d8c131-35f8-4dcb-a834-895e831b04b9`、接受时间 **2026-11-05 06:00:01 UTC**。该精确 metadata 单列来源，不冒充截图本身暴露了后端事件字段。

### 默认 Profile、执行与独立 Review

执行 Run `7d3b4ea8-c9f5-4d87-8d91-28c7b6608355` 的冻结 identity 界面显示：

| 字段 | 界面中的实际值 |
|---|---|
| Agent / Model | Claude Code / `claude-haiku-5-5` |
| Credential type / Route | Official subscription / `claude_code_cli` |
| Profile | Default agent profile，v1 |
| Selected by / Reason | Default profile / Inherited preferred models |

Review Run 为 `6d2409ea-8911-4db5-801c-75b65da05585`，候选 ID 为 `6bae401a-b4d2-486b-b6d5-e96bc12a0678`。通过正常 Owner UI 读取的 Review 报告记录了独立、只读的 `mikka.inspect_artifact` 检查：

- `mikka-1284-default-ready.txt` 为 36 字节，内容精确为 `mikka-1284-default-ready\n6 * 7 = 42\n`。
- SHA256 为 `2477b0bbddcb38a090a51700a4d4106a31cfb0efada1932edc7afc42af56c00b`；`committedSha256` 相同，`contentMatchesGit=true`、`matchesExpectedUtf8=true`。
- 三条 Review criteria 均为 passed，UI 的 Independent results 显示 **Review — Merge suggested / Independent review**。
- `candidate.sha` 仍为 **null**；实际读到的 **artifact snapshot HEAD** 是 `5266aa0da32a8a6bdd6901ae21c610a93d26255e`。这两个字段分别保留，不用 artifact HEAD 填充缺失的候选 SHA。
- Review 没有改代码、没有执行 shell，也没有获授 `verifyCommand`；报告的 `verify.status=not_run`。没有把一次只读 Review 写成额外 Verify 已通过。

生产命令记录是 producer observations；独立 Review 使用的 artifact 读取是另一项证据。现有材料未暴露 producer 的实际 shell 退出码、Review 的 model、完整 Profile 字段与 definitionDigest、连接 ID、billing 等字段，在 JSON 中均诚实标为 `not_exposed`。原始 Native SID 不复制，仅保留来源记录中的 producer SHA256 `73c3bfe72221a083312ce3f1f9e2e93d61201bb1acb2c58eb55e724c4ef6d03e`；后续工具总结仅补充两条 attempt session 均存在且不同，不输出原值或捏造 Review 的 session hash。

### 后续只读 Coordinator metadata

来源明确记录为 **`normalCoordinator read-only tools summarized in observed UI`**：正常 `get_issue`、`get_factory_task`、`get_run` 的结果已由 Coordinator 在可见 UI 中总结，这里只保存结构化事实及来源标注；完整 Coordinator 对话仅留在 scratch 作为诊断来源，不纳入代码仓库。`get_factory_task` 的 Raw data 已在正常 UI 展开，但只显示约 200 字节的截断片段，未取得完整原始 tool trace；因此不升级 provenance。以下 metadata 与直接截图中的 Accepted/Done/identity 观察分层保存：

- Task route 的 `flowVersion=2`，`stage=approval`、`status=passed`、`revision=9`；execute / review / approval 各一次，均 passed；Issue 为 done。
- Execute：05:47:37.669Z → 05:49:02.036Z；Review：05:49:23.496Z → 05:50:49.032Z。可见总结明确写明两者 harness 均为 **`claude_code`**、`status=succeeded`、`stopReason=submitted`，error 为空；这仍是 UI 总结中的字段，没有据此声称取得完整原始 trace。
- 两条 attempt session 存在且不同。工具未暴露完整 agentProfile、definitionDigest、model 或 billing；实际 execute 模型与官方订阅路线仍以冻结 identity 截图为依据。此零配置案例不作为 Claude Code → Codex review 的证明。

Owner 截图左侧 Coordinator 消息仍描述接受前的 approval pending / Waiting for you；当前任务页首和页尾已经显示 Accepted。该历史消息不作为最终任务状态。

### 证据文件与范围

结构化记录为 `zero-prod-acceptance.json`。来源文件及 SHA256：

| 文件 | SHA256 |
|---|---|
| `issue1284-zero-review-observed.json` | `3ab0968091ad337021c40a3a76499fab23641afca289ebc72d76271876ff6492` |
| `issue1284-zero-owner-accepted.jpg` | `5f5fded345994caef56fa3e314e80168d870d4aa32227dc58ce12b41cb3633a7` |
| `issue1284-zero-default-identity-f4732608.jpg` | `ab36c9d05f795bbe25556f8da94e10a7bc4aa3610c605ef96e952dc2d473cd77` |
| `release-f4732608.json` | `88358a6251633d4e9f01a6a043f217b48c1b6d1e973005b423a88dd622669a44` |

两张图是真实生产 Owner UI，尺寸分别为 1021 × 885（Accepted）和 576 × 388（冻结 identity）；不是之前的合成视觉夹具。

**本段只完成零配置任务的生产验收记录。** 自定义 Frontend/Codex Profiles、自动选择及同一 Task 的 Claude Code → Codex Review 验收尚未在本段建立，issue #1284 整体验收仍在进行。此证据整理没有操作浏览器、生产 SQL、Docker、GitHub 或产品源码。

## 自定义 Profiles 首轮生产结果与冻结元数据补充（2026-11-05）

正常 Owner 会话通过既有只读 `/api/runs/{runId}/evidence` 页面读取了四个实际 Run 的冻结投影，见 `profile-metadata-supplement.json`。该补充直接确认零配置 execute 和 review 均为 Claude Code / `claude-haiku-5-5` / 官方订阅 `claude_code_cli`，并补齐 Profile ID、版本、digest、source、reason；不再依赖 Coordinator 对这些字段的总结。此前记录中 `not_exposed` 描述的是此前界面与工具的暴露范围，后续补充没有改写此前观察。

| 场景 | 实际 Run | 冻结 Profile | 状态 |
|---|---|---|---|
| 零配置实现 | `7d3b4ea8-c9f5-4d87-8d91-28c7b6608355` | `default` v1 | succeeded；同 Task 已 Owner Accepted |
| 零配置独立审阅 | `6d2409ea-8911-4db5-801c-75b65da05585` | `default` v1 | succeeded；同为 Claude Code，不作为跨 Harness 证明 |
| 前端自动选择 | `aef86f65-3c9b-4434-8f50-eaaed004678b` | `55e1952f-0129-43c6-9690-2f1b9d99e6b2` v1 | failed；启动前 Profile 准入拦截 |
| 后端自动选择 | `52c25088-3cbf-4e3f-882f-d7b3296637a4` | `923c75f2-cecb-4bb2-b812-646d057e8a22` v1 | succeeded；独立 Review 尚未派发 |

两个自定义执行 Run 的冻结 `source=decision`、`reason=capability_fit`。前端采用继承优先模型、限制 Claude Code；后端固定 Claude Code / Haiku / 原官方 Claude 来源。当前配置读回显示两个 Profile 的版本和 digest 与 Run 冻结一致，且 createdAt 与 updatedAt 一致；本轮没有修改它们。

### 前端首次认领失败

ALEX-66 / Task `9c1da61e-14e2-4a96-a228-7085bebcfd5a` 的自动选择成功，随后 UI 报告所选 Profile 发生变化或不可用，未观察到 native Agent start、工具步骤或候选。完整结构化记录为 `frontend-first-claim-failure.json`。该通用文案不能证明 Profile 实际被修改，也不能证明供应商额度不足；Docker 调查尚未确定具体拒绝检查。原失败保留，尚未人工重试。

### 后端执行完成，但 Review Decision 拦截

ALEX-67 / Task `b5785091-2c95-4f55-821d-fce51e027b0e` 实际 Claude Code native Agent start 为 19.7 秒，正常提交了修复夹具的两个文件。生产 Run 的现有 Owner 证据投影确认 `status=succeeded`。执行者报告起始实现 4/8、exit 1，修复后 8/8、exit 0；这些测试数量仍标注为 producer 报告，尚未升级为独立 Review 结论。

按该 Run ID 限定读取的 Vercel 日志，在 **06:15:08.560Z** 的 complete 请求记录 `agentProfileDecisionUnavailable`，并退到 Coordinator 唤醒。由该请求返回的唯一 workflow ID 进一步限定查询，确认 **06:15:37.793Z** 的 `prepareTurn` 在 4 次尝试后因同一错误终止。现有日志无法区分合法 none、无效响应或被过滤后的候选不足；没有把它写成 Codex 配额不足。日志 deployment `dpl_3nCUgLbKkAA8g3HZTkpj1qxHqMQq` 的元数据确认其生产代码为 `7bf009959071afe4d9e6963a9c9bd81085d33a4b`。

`backend-first-review-failure.json` 保存了安全字段和精确日志定位；`issue1284-backend-v1-native-identity-0628.jpg` 是当前正常 Owner 冻结身份截图。配置中的 Codex Review Profile 为 `1880144e-4005-4d72-b3e3-6f362fbe8bd8` v1、固定 `gpt-6-luna` 与原官方 ChatGPT 来源；它尚未形成该 Task 的 Review Run，不能以配置存在冒充执行。

### 当前范围

06:31 的无探测管理接口对三个 Profile 和默认路径均显示 `checking`；这只是当前缓存可用性观察，不能倒推失败时的候选目录或供应商余额。06:33 前后普通浏览器读取生产 `/api/version` 已显示 `81f8493c1a76f371f90008ddacc039abf185eaba`，故不把后续只读操作归到 7bf。两个实际失败继续在 Docker Agentic Platform Large 内复现和修复，严格保留现有权限、来源和 Decision 校验。

**#1284 保持 open。** 自定义前端完成、Codex 独立 Review、同 Task 跨 Harness、编辑冻结与显式选择等剩余验收尚未宣称完成。DeepSeek API 按 Alex 当前指示排除，没有发起测试或余额探测。

新增 JSON 发布前使用既有真实 TestAccountPool credential/cookie ledger 执行仓库 `auditEvidence`，收据分别为 `issue1284-prod-evidence-audit-receipt.json`、`issue1284-backend-review-evidence-audit-receipt.json` 、`issue1284-profile-metadata-evidence-audit-receipt.json` 和 `issue1284-factory-state-evidence-audit-receipt.json`。截图经人工逐张检查仅保留本次任务标识、Profile 和模型/来源字段；完整 Coordinator 对话、账号主体标识、原生 SID 和凭证均未发布。


### 06:37–06:38 Factory 状态补充

现有 Owner FactoryTask GET 显示：ALEX-67 的 Run 虽为 succeeded，Factory 本身却仍为 execute / blocked / revision 3，candidateId=null、candidates=[]、checks=[]；06:35:21 的原因是自动恢复次数耗尽。它提供正常 completionRecovery 绑定（同 Task、revision 3）。此前 Issue 页面 In Review 只作为界面观察保留，不冒充 Factory 阶段。ALEX-66 同为 execute / blocked / revision 3、唯一一次尝试、无候选，其持久原因是 `Question recovery blocked: factoryQuestionRunMismatch`，与 Run 的通用 Profile 文案分别记录。见 `factory-state-supplement.json`。两项尚未人工重试，继续用 Docker 查明因果并保留同 Task 恢复路径。


## Profile 拒绝诊断与独立审阅恢复：发布前验证

新增 [#1358 恢复修复完整证据](profile-recovery-5251/README.md)，当前批次提交 `5251a6bfeda13c2e6c300dfba5fa0841ee0e9f8a`，tree `d1397ffac0a07e2a8a62290a161839d44a2b0a97`。

- 当前 head CI：17 success＋1预期OIDC skip；完整 Docker production build 成功。
- 最新主线整合的同树本地提交585c：136/136定点检查、types/lint/diff通过。此前42b的276项和UI91＋44仍归属原版本。
- 当前5251正常TestAccountPool／Next session HTTP：51/51，双fixture及会话清理完成；不含原生模型执行。
- 四张实际本地production build页面明确摄于42b，经过36文件与4语言子树核对后用于未变化的5251恢复界面；无版本改标。
- ALEX66原始claim根因仍未知；ALEX67真实生产恢复、Codex审阅与Owner Accept等待本批上线后独立验收。API路径按用户指示跳过，未查余额或发请求。

本次增量保留以上旧证据与原失败，不覆盖或改写此前的生产观察。#1284仍保持打开。

