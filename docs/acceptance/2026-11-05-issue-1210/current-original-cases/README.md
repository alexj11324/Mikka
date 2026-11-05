# 原案例生产只读复核：2026-11-05 00:33–00:35 UTC

本目录保存本次实际生产 SELECT 的原始结果、对应 SQL，以及指定 DeepSeek key 的免费余额结果。没有写入生产业务数据，没有重试模型，也没有将历史执行当成本次执行。

## 当前结果

| 原案例 | 本次实际状态 | 解释 |
| --- | --- | --- |
| Codex 390 | `approval / passed / revision 35`，候选 `b251f0b5-3aa6-4e70-b57a-282161c969a1` | 仍保持此前原 Owner 的正式验收结果。本次只读，没有重新执行或签发验收回执。 |
| API a9e472 | `execute / failed / revision 12`，候选为空 | 已有四次 `deepseek-flash` 运行，均已结束且没有 live lease；不能继续沿用 issue 正文初始的“还没开始”。 |
| #1209 后续 CC Factory | `verify / waiting / revision 13` | 问题仍为 `waiting_user`，没有 answer、answerSource 或 continuationRunId；需要原 Owner 的正常登录入口回答。 |

Codex 与 API 的数据库观测时间为 **00:33:50.804327 UTC**；CC 的数据库观测时间为 **00:33:10.023196 UTC**。所有时间来自返回的 `clock_timestamp()`。三个案例在本次查询覆盖的范围内均没有未过期运行租约；这不代表整个生产项目空闲。

## Codex 的已完成验收与历史边界

此前修复 [#1250](https://github.com/alexj11324/Mikka/pull/1250) 后，原候选已通过独立 review、verify 和唯一 Owner 验收。两次新检查分别为 `4545fb6d-745f-4997-8785-5d263a67de96`、`03e5559f-c67d-455b-813f-d64b085a7907`，均是 `gpt-6-luna` 且 succeeded。

完整的正常 Owner UI、公开版本、实际 native claim 与产物证据仍以 [6617025 固定记录](https://github.com/alexj11324/Mikka/blob/6617025671a82036246aa5696dccdf39b6bc61bd/docs/acceptance/2026-11-04-issue-1166/updates/codex390-1250/README.md) 为准；证据已追加到 [#1154](https://github.com/alexj11324/Mikka/issues/1154#issuecomment-6640043326)。本目录不会把这项此前完成的验收说成本次重跑。

原始查询同时保留该 issue 的更早运行，包括旧模型标识和 E57 失败。它们属于历史记录，既不改写，也不算本轮的新模型执行。

## API 的失败与当前免费余额

此前正常 UI 发起的原 API 案例遇到 `402 Insufficient Balance`，随后发生原机制的三次自动 Repair；不是本次手动重复调用。四次均用 `deepseek-flash`，未进入独立 review、verify 或 Owner 验收。原始失败、实际 claim 与偏好恢复证据见 [c8bed66 固定记录](https://github.com/alexj11324/Mikka/blob/c8bed66922b925e3cc6617b49b25a40df4b634af/docs/acceptance/2026-11-04-issue-1166/updates/api-a9e472-balance-20261104-1424.md)。

本次 **00:34:59.641 UTC**，先运行仓库 `node scripts/assert-test-model.mjs deepseek-flash`，exit 0；随后只对指定既有 key 查询免费余额端点，HTTP 200、`available=false`、**模型调用 0**。结果见 `prescribed-balance.json`。没有记录 key 或余额金额，没有换模型或凭证来源。此结果只代表该查询时刻可用性。

## CC 待答问题

任务 `e42571e5-58f7-40e3-9418-c02ee8843fe6` 的问题 `31b87a5f-7be6-49e9-9031-126dd2144007` 是 verify 阶段的 `decision`，revision 2，截止 **2026-11-05 20:15:32.526505 UTC**。该问题与已经完成的旧 CC 7d2c91 案例不同。

原 Owner 是三个原案例中的同一账号。本次正常 smoke 账号预检属于另一个 Owner；没有复制 grant、构造会话或用管理入口代替 Owner 回答。此处只保存状态，不声称完成继续执行。

## 剩余与范围

#1210 的原 API 三阶段、#1209 剩余正常群聊/Factory 三路径、#1217 合并前的真实付费 cloud leg 及合并后的 sleeping-parent 三路径仍未通过。#1211/#1212 的固定真实任务一小时前后记录与其余实现、生产行为验收亦未完成。

本记录不修改告警阈值或生产 Neon 设置，不关闭跟踪 issue。已部署 #1293 的具体 Web/Worker 发布和公共 build 证明另见 [34e5ce6](https://github.com/alexj11324/Mikka/tree/34e5ce67c3a374a13d6a13961623fa2295e25156/docs/acceptance/2026-11-05-issue-1212/deployment-a18)。

## 后续只读复核：2026-11-05 02:06–02:08 UTC

以下为原 Owner 的同三个原案例在后续时间点的限定范围复核，追加到前述 00:33–00:35 UTC 原始记录之后。没有提交 Owner 答案、续跑、模型请求或新的验收回执；本段不把状态查询当作新的功能验收，也不表示整个生产项目空闲。

| 数据库实际观察时间（UTC） | 原案例 | 本次状态与范围 |
| --- | --- | --- |
| 02:06:06.425424 | CC Factory | task `e42571e5-58f7-40e3-9418-c02ee8843fe6` 仍是 `verify / waiting / revision 13`，候选 `2f338962-c690-4ba7-bc63-6c73a9de3acb`。问题 `31b87a5f-7be6-49e9-9031-126dd2144007` 仍为 `decision / waiting_user / revision 2`；answerId、answerSource、answeredAt、continuationRunId 均为空。该原案例未过期运行租约为 0。 |
| 02:08:06.791705 | Codex 390 | 仍是 `approval / passed / revision 35`，原候选 `b251f0b5-3aa6-4e70-b57a-282161c969a1`；该原案例未过期运行租约为 0。既有正式验收保持，本次没有重跑。 |
| 02:08:06.791705 | API a9e472 | 仍是 `execute / failed / revision 12`，候选为空，已有 4 个 failed run；该原案例未过期运行租约为 0。本次没有再次调用或更换模型。 |

CC 问题的现有截止时间仍为 **2026-11-05 20:15:32.526505 UTC**。后续仍需原 Owner 的正常入口完成回答；此处没有代替 Owner 作答或构造新会话。

本次 **没有复查 DeepSeek 余额**。本目录 `prescribed-balance.json` 记录的 `available=false` 仍仅对应 **00:34:59.641 UTC** 的那次免费余额查询，不能改写成 02:08 的最新余额。

### 新增原件与首次默认数据库失败说明

- [CC 02:06 原始 SELECT 与返回](cc-case-020606-readback.json)，SHA-256 `e5231e91e2733c71bc6797bf72427714bb358396289c8f80fed778932b681ea6`。
- [API / Codex 02:08 原始 SELECT 与返回](api-codex-020806-readback.json)，SHA-256 `ca0828204cbc0edb80f010dc4d5525f458ad39c818a72696093f7794790afde5`。

新原件保留明确目标 project `autumn-fire-21908520`、branch `br-autumn-rain-b5leflom`、database `orvilo_mvp`，并按既有 owner 与 task / issue 限定 SELECT。首次 connector 默认数据库尝试报告 `relation factory_tasks does not exist`，没有写入；随后通过只读数据库目录确认目标，显式指定 `orvilo_mvp` 后以相同 SELECT 成功。该过程保留在 CC 原件的 `initialDefaultDatabaseAttempt`，没有将默认数据库选择失败误报为生产任务的新故障。

本段只追加时间点说明与两个 JSON；先前五份数据 / SQL / 余额原件及 README 的原始段落全部保留。
