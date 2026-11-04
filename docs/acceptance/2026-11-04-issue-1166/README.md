# Issue #1166：2026-11-04 生产验收增量证据

本目录保存截至 **2026-11-04 06:00 UTC** 的新增安全观察。**整体交接尚未完成，不能关闭 #1166。** 原有 2026-11-03 目录的 10 个文件与四张截图保持原字节；本目录单独记录新的成功、失败与未开始事项。

## 当前结论

| 路径 | 真实结果 | 证据边界 |
| --- | --- | --- |
| 新 CC 任务 7d2c91 | 已完成执行、独立 review、独立 verify 和正常 Owner UI 验收 | 三个不同原生会话，3 个实际 Claude Code 订阅 claim，0 个 API claim；两次完整实际文件检查 |
| 原 Codex 390 恢复任务 | 原 producer / SID 保留，85 字节候选恢复成功；当前 review 失败 | 文件正文、字节、哈希、Git、算式已实际核对；第五条命令证据判定失败，尚无 verify 或 Owner 验收 |
| 新 API 任务 a9e472 | 尚未开始 | 最新只读预检为 issue / task / run / API claim / subscription claim 全 0；优先级未改 |
| 旧 strict physical AFTER | **FAILED，保持原结论** | historical_database_row_changed / compare_after；不得用新的增量比较替换旧 baseline 或改写结果 |

新 CC 的唯一 issue 是 e598dc4c-848f-4240-bf90-9d1112f3b113，task 为 08e3df90-1878-4d31-bb02-b32cb7c7d258，候选为 74d6465d-fa44-432e-8187-d8544f30858f。Owner 于 05:43:36.435Z 唯一点击，05:43:36.730Z 形成唯一有效 receipt；页面显示“已验收”，数据库为 approval / passed / revision 12。

当前执行环境在随后保存截图时断开，并被标记为 unavailable。新增截图没有得到可用文件确认，因此本目录不添加截图，也不声称截图已保存。代码仓库、CI 和只读数据库连接仍可用；正常生产页面操作与 API 实测尚待浏览器恢复。

## 已发布修复与版本

- [#1200](https://github.com/alexj11324/Mikka/pull/1200)：受限兼容真实旧 question-resume journal，原 producer 的 retained snapshot 恢复于 05:19:25 成功。合并版本 62bb445860642cb110b37e00794daf06ab454f88；对应最终生产 deployment 已 READY。
- [#1201](https://github.com/alexj11324/Mikka/pull/1201)：修复真实完整订阅请求超过原输入字节边界的问题。合并版本 7b6c1ee1b4a53563b2d6d9885ad992858514cd7a；最终 deployment dpl_EJC6ev9gDootduhzSggG6YLd2Udi 于 05:29:37 READY，05:47 的生产域名只读核验仍指向它。
- 新 CC 成功发生在 #1201 的最终生产发布之后。来源与 worker 的精确版本见 production-releases.json。
- CI 通过和部署 READY 仅证明对应发布门禁；不代替尚未完成的原 Codex 或新 API 生产验收。

## CC 的实际证据

文件 factory-1166-final-cc-7d2c91.txt 为精确 65 字节，SHA-256 为 3ac41740fdfcf500ab16088d022cc1472820b0386d33fc8e7f40dfe543ac77dd。两个独立检查读取完整三行正文，均得到相同 committedSha256、contentMatchesGit=true、matchesExpectedUtf8=true 和 HEAD 4a796fa888fbd0ef521762c29cbd25fe93578936，并分别判断 7 × 8 = 56。

三个实际 native claim 均为 claude_code / claude-opus-5-5 / subscription，绑定 dabd9bd4-2a79-40a8-85dc-1b3db772db19 → 93b6ab23-900b-4e18-9ea0-baccf2d104ce revision 2。providerObservedModel 没有独立遥测，不能把冻结型号与 claim 进一步写成独立验证了 provider alias 的实际版本。

Producer 的实际 Bash 输入输出对证明执行了写、读、字节、哈希和 shell 算术检查；工具结果没有单独的 exitCode 字段，归档明确记为 null。report 中的 exitCode 属于报告字段，不能替代实际工具观察。

05:32 的第一次正常重发已完成三次订阅生成。它创建了一个 issue 后，因测试指令误选 dispatch_run 而得到 repositoryRequired，没有生成 native run。05:34 通过正常 UI 更正为同一 issue 的 dispatch_bot_computer，之后完成三个阶段；入口错误没有归因于订阅故障，也没有创建第二个 issue。

## 原 Codex 仍未通过的原因

原 390 的持久化 run_chunks 只有 submit 输入输出对，没有 producerCommandObservations 可读取的命令对。本次没有读取 390 native JSONL，因此不能据此断言 SDK 没有执行过其他命令。

已只读确认直接前驱 E57 在原 Owner answer 之后确实执行了完整检查，得到 85B、正确正文和 SHA、HEAD8f、committed blob 相同、Git clean 及 7 - 4 = 3。唯一 question_recover 收据 ec982956-3302-5588-bcac-2a209a5db623 将 E57 绑定到 390 的原 execute attempt、原问题、SID、owner/task/issue/epoch；不能只凭同一个 SID 推断继承，也不能用两个 attempt 的空 requestEpoch 字段代替不可变收据证明。

这份历史记录可以作为严格带来源的待核验证据，**不能称为 390 当轮新命令，也不能自动使 criterion 通过**。有效要求若明确需要 390 当轮新鲜执行，历史记录仍不足；对应语义边界必须在实施前核清。

当前原任务仍是 review / failed / revision 24，candidate b251f0b5-3aa6-4e70-b57a-282161c969a1，producer 390、原 SID 和历史报告保持。旧 strict AFTER 因 outcomeAt 历史行变化而失败的结论不变。05:19 恢复前后的 11 行一致仅是另一个观察时段。

## 未完成的修复与验收

具体方案见 next-steps.md。需要修复的真实路径包括：严格带来源的直接前驱命令展示、通用 continue-repair 绕过既有 repair budget 的保护缺口，以及正常 Owner 同候选重审入口。

只读发现表明，Factory 自动 lifecycle 的 repair 已被 count=4 > maxFixAttempts=3 阻止，但通用 Coordinator dispatch 可到达另一条未检查预算的 continue-repair 分支。本案当前 failed 状态还有下游 ancestry guard；Owner retry 之后的 pending 检查则不进入该 failed-check guard，留下实际可达的替代执行窗口。不能用预算数值承诺全系统已绝对禁止替代 producer。原任务后续重审须先验证这条保护，且保留当前 candidate / producer / epoch。

新 API 测试必须使用现有 DeepSeek key、claude_code 和仓库测试政策允许的 deepseek-flash，三个阶段都核真实 key claim。早先 Pro 方案仅处于准备状态，已在任何新调用之前校正；06:00 的窄查询确认既有 key 列有 deepseek-flash。恢复环境后，付费测试前仍需实际运行现有 assert-test-model.mjs，不能把本次静态审查称为脚本已执行。需要先通过正常 UI 调整同 harness 的优先级，记录前后指纹并保护其他并行工作；测试后只在仍与本次写入一致时恢复。不得将 CC 或 Codex 回退调用计入 API 验收。

## 目录

- cases/cc-7d2c91-owner-accepted.json：实际来源、三个独立 SID、两个完整 inspect、生产 Owner receipt 与最终静默状态。
- cases/codex-390-recovery-incomplete.json：当前失败状态、恢复候选、保留的旧 strict failure。
- cases/codex-direct-predecessor-observations.json：C7/E57 历史命令白名单及唯一恢复收据；方案尚未实施。
- cases/api-a9e472-not-started.json：零任务预检、现有资源安全元数据和下一步。
- cases/repair-budget-boundary.json：预算、完成收据和 pending 续跑缺口的安全投影。
- api-a9e472-prompt-v3.txt：遵守 Flash 测试政策、尚未发送的 API 任务指令。
- production-releases.json：对应 merge、CI、最终部署和 worker 版本。
- next-steps.md：剩余修复门禁与生产验收次序。
- manifest.json：本次新增文件的 Git blob SHA 与 UTF-8 大小；不覆盖旧目录 manifest。

本目录不含凭据值、Cookie、session token、原始运行日志、完整用户 prompt 或 provider 原始错误。生产 SQL 均为 SELECT；没有访问受保护 Acme VM。原 #1116 离线未知 WIP 仍为独立未完成事项。
