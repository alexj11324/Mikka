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
