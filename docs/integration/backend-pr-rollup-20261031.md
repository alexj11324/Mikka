# Backend PR rollup — 2026-10-31

The inventory was frozen at 2026-10-31 04:36:46 UTC; only PRs created before 02:36:46 UTC were eligible. All 27 open PRs were inspected. Frontend and mixed frontend implementation remain with cc.

## Final scope

| Source PR | Reviewed head | Disposition |
| --- | --- | --- |
| #486 | `098bdfe658a13ca8633d1b13345870295800ba93` | Include standalone actor validation and PG17 concurrent-writer/invalid-row regressions; close after #605 merges |
| #565 | `fa78bb0658980f2890f7037db7dfafd3a1c93210` | Include explicit execution defaults, discovered slots and opt-in account fallback (#537); close after #605 merges |
| #576 | `59ae2c2fefc2ad1cedc2d65ab44f3ed460f5d189` | A parallel task merged this at 05:37:04 UTC as `326fd49b342ad50d8e16378188283a1974752ca9`; preserve its final implementation and applied migration names |

The original rollup included #576. Its parallel merge changed the baseline while browser verification was running. The final PR merges current main, removes duplicate copies of its nine migrations, and delivers the remaining #565/#486 changes plus a claim-access denial regression. It does not reapply #576's DDL or revert its fixes.

## Integration decisions

- Preserve main's subscription-free Coordinator hosted-model fallback. An unavailable explicit subscription still refuses; a named Bot still requires its executor. The old #565 file would break subscription-free Coordinator dispatch (occurrence 10 × impact 8 = 80); existing `lib/bot-model-selection.test.ts` covers the retained behavior.
- Preserve #598 plugins and the complete current main DB-suite inventory. Current main also contains #576's immutable action pins and release regressions, so retain those versions.
- Keep current workspace navigation selectors and #486's test-only account input-value readiness fix. No production frontend implementation is included.
- The quota fixture isolates model-admission IO while asserting exact owner/workspace/model. The benchmark route fixture additionally verifies task-access denial before claim, token or Skill receipt creation; production authorization remains intact.
- Preserve ordinary Linear bidirectional sync's explicitly chosen default-off setting and main's enabled feature defaults.

## Migrations and rollback

Only three migrations are new relative to `326fd49b`. They follow its latest `20261031050737_account_deletion_warnings.sql` and preserve the source SQL bodies:

| Source filename | Final filename |
| --- | --- |
| `20261030233501_validate_activity_actor_type.sql` | `20261031054015_validate_activity_actor_type.sql` |
| `20261030233502_validate_activity_actor_id.sql` | `20261031054016_validate_activity_actor_id.sql` |
| `20261031001500_explicit_execution.sql` | `20261031054017_explicit_execution.sql` |

All existing main migrations and ledger names remain unchanged. The earlier rollup's alternative copies of #576's migrations are removed before deployment. Constraint validation remains nontransactional and permits concurrent writes; invalid legacy rows fail closed. The explicit-rule conversion keeps saved selections and adds a unique default row per scope. Reverting application code may retain the additive schema; do not recreate automatic choices or drop audit/deletion evidence during rollback.

## Verification and boundaries

Use cloud Linux, pnpm 10.34.3 and task-owned ephemeral PostgreSQL 17 on loopback (`mikka_e2e`). Verify migration from the exact merged-main ledger to this branch, then replay/bootstrap, execution settings, source checks and required CI/browser jobs. The PR records final-head results.

A primary browser run on the earlier `44fab50a` head hit an intermittent return-to-board timeout; the independent targeted job passed the same case and all 115 cases. Evidence and low-risk triage (2 × 2 = 4) are tracked in #606 for cc; no speculative frontend fix is included. That earlier run's results do not substitute for verification of the reconciled head.

This PR does not claim new live-provider, Team Skills browser, production legacy-data or production disaster-recovery acceptance. Preserve owner-provided OAuth acceptance and the scoped boundaries recorded on main. Production validation scan duration still depends on real table size and legacy rows.

## Complete open-PR inventory

The snapshot contains 27 PRs: 20 older than the cutoff (3 selected backend PRs and 17 frontend/mixed PRs), plus 7 newer frontend PRs. Classification uses changed files and branch history as well as the title. In particular, #547 and #567 contain substantive backend changes coupled to frontend feature flows; these are explicitly left with cc rather than counted as already delivered. A differing old file blob does not by itself mean missing behavior: the legacy branches also predate subsequent fixes on main.

| PR | Topic | Disposition / dependency |
| --- | --- | --- |
| [#604](https://github.com/alexj11324/Mikka/pull/604) | fix(ui): interface-design review fixes, and vendor the interface-design skill | 新于本次两小时截止时间；前端/桌面 UI，保持打开留给 cc。 |
| [#603](https://github.com/alexj11324/Mikka/pull/603) | feat(ui): coloured chart palette for chat charts | 新于本次两小时截止时间；前端/桌面 UI，保持打开留给 cc。 |
| [#602](https://github.com/alexj11324/Mikka/pull/602) | fix(desktop): open Composio's connect screen directly from 连接 | 新于本次两小时截止时间；前端/桌面 UI，保持打开留给 cc。 |
| [#599](https://github.com/alexj11324/Mikka/pull/599) | fix(ui): tags, in-chat cards and side-panel springs (UI consistency steps 4–6) | 新于本次两小时截止时间；前端/桌面 UI，保持打开留给 cc。 |
| [#596](https://github.com/alexj11324/Mikka/pull/596) | fix(ui): sweep explanatory copy, double frames, outlined search and partial row hover | 新于本次两小时截止时间；前端/桌面 UI，保持打开留给 cc。 |
| [#591](https://github.com/alexj11324/Mikka/pull/591) | feat(settings): open Settings inside the app shell, like Codex; remove 活动; prefetch sections | 新于本次两小时截止时间；前端/桌面 UI，保持打开留给 cc。 |
| [#585](https://github.com/alexj11324/Mikka/pull/585) | feat(plugins): one 插件 list for the rail page and 设置 › 连接 | 新于本次两小时截止时间；前端/桌面 UI，保持打开留给 cc。 |
| [#576](https://github.com/alexj11324/Mikka/pull/576) | Charge actual model usage and integrate older backend fixes | 后端：并行任务已于 05:37:04 UTC 合并；本 PR 保留 main 已应用的版本和迁移账本。 |
| [#567](https://github.com/alexj11324/Mikka/pull/567) | feat(captures): a recording's step timeline, in the agent's own words | 混合：录像步骤 API、daemon 工具 schema 与时间线 UI；还包含 #547 验收合并依赖，整项留给 cc。 |
| [#565](https://github.com/alexj11324/Mikka/pull/565) | Execution settings: explicit defaults, model slots and opt-in fallbacks (#537) | 后端：纳入本整合 PR，通过验证后合并并关闭来源 PR。 |
| [#557](https://github.com/alexj11324/Mikka/pull/557) | feat(settings): 重新播放引导, E2B key per workspace with BYO state, PAT flag (#538 UI) | 前端接入：设置页、E2B/BYO 展示和占位适配器；真实权限/工作区接口由已合并后端提供，需 cc 接线。 |
| [#556](https://github.com/alexj11324/Mikka/pull/556) | feat(settings): rule label cell picks from workspace labels, chip in the label's colour (#539 UI) | 前端接入：标签选择器、颜色和可见标签适配器；需 cc 接工作区标签接口。 |
| [#552](https://github.com/alexj11324/Mikka/pull/552) | feat(factory): candidate card shows PR title, preview DB branch, machine and per-criterion command (#541 UI) | 前端：候选卡及证据视图字段与展示，依赖 #532。 |
| [#549](https://github.com/alexj11324/Mikka/pull/549) | feat(devices): uninstall-on-remove copy, SSH host details and cancel (#536, #540) | 前端：设备移除、SSH 详情和取消交互，包含 #534/#529 的 UI 依赖。 |
| [#547](https://github.com/alexj11324/Mikka/pull/547) | feat(factory): acceptance is the person's own merge of the candidate PR (#528) | 混合：新增 factory_merges、本人 GitHub token 验收合并 API 和决策栏状态；完整产品流留给 cc。 |
| [#546](https://github.com/alexj11324/Mikka/pull/546) | feat(threads): 等待设备上线 chip in the thread list (WS-38) | 前端：等待设备状态 chip，携带设备/执行设置 UI 的分支依赖。 |
| [#534](https://github.com/alexj11324/Mikka/pull/534) | feat(devices): device page and desktop SSH install flow (#504, part 2) | 前端：设备页和桌面 SSH 安装，含 #529 设置页依赖。 |
| [#533](https://github.com/alexj11324/Mikka/pull/533) | feat(onboarding): first-run guide UI on the merged backend | 前端：在已合并 onboarding 后端上实现首次引导，是 #478 的后续分支。 |
| [#532](https://github.com/alexj11324/Mikka/pull/532) | feat(factory): A3 acceptance tab and evidence viewer on run captures | 前端：A3 验收证据查看器，是 #483 的后续分支。 |
| [#530](https://github.com/alexj11324/Mikka/pull/530) | Computer policy settings: only Allow and Deny | 前端：计算机策略 Allow/Deny 设置；后端默认允许已在 main，承接 #481。 |
| [#529](https://github.com/alexj11324/Mikka/pull/529) | feat(settings): Bot 与 Agents page and R-74 label components (#504, part 1) | 前端：Bot 与 Agents 设置页及执行规则展示/客户端适配器，需接 #565 明确执行设置。 |
| [#486](https://github.com/alexj11324/Mikka/pull/486) | fix(migrations): validate actor checks without long exclusive locks (#116) | 后端：纳入本整合 PR，通过验证后合并并关闭来源 PR。 |
| [#483](https://github.com/alexj11324/Mikka/pull/483) | feat(factory): A3 acceptance evidence viewer on run captures | 旧混合分支：证据访问后端已在 main 后续版本中演进；查看器由 #532 承接，留 cc 判定关闭旧分支。 |
| [#482](https://github.com/alexj11324/Mikka/pull/482) | feat(settings): v4 remaining sections from Figma (令牌, 密钥与环境, 审计日志, 常规, 用量, 计费, 团队权限) | 旧混合分支：设置页和大量历史后端；审计/令牌/密钥/用量等后端已在 main 演进，#576 补全后端；页面由 cc 处理。 |
| [#481](https://github.com/alexj11324/Mikka/pull/481) | fix(computer): bots operate computers by default; no human approval step | 旧混合分支：默认计算机允许的后端已在 main 后续修订中保留；设置 UI 由 #530 承接，留 cc 判定关闭。 |
| [#480](https://github.com/alexj11324/Mikka/pull/480) | feat(settings): personal bot settings + workspace model allowlist (replaces #442/#466) | 旧混合分支：个人 Bot 设置/模型策略 UI 及历史后端；当前模型 admission 后端由 #576 完善，UI 留给 cc。 |
| [#478](https://github.com/alexj11324/Mikka/pull/478) | feat(onboarding): first-run guide for new accounts | 旧混合分支：onboarding 记录/接口已合入 main 后续版本；引导 UI 由 #533 承接，留 cc 判定关闭。 |
