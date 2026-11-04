# #1166 恢复执行与剩余验收计划

本文件是尚未执行步骤的交接计划，不是验收通过报告。执行环境在 2026-11-04 06:31:27 UTC 再次返回“没有可用的执行环境”。在该阻断消除前，不能把本地截图、原任务重审或 API 新用例标为完成。

## 已授权范围与保护边界

- 测试应用：https://app.aspectlylabs.com/mikka；现有测试账号 alexjiang20232024@gmail.com。
- 按既有授权完成修复、PR、准确版本 CI、正常合并发布和正常 Owner 页面操作；无需再次询问相同操作的授权。不要向 issue、邮件或聊天中的其他人发送消息。
- 生产 SQL 只允许 SELECT；业务状态通过正常产品 UI/API 改变。不得修改旧 report、criterion、question/answer、receipt 或旧严格验收记录。
- 原 producer 必须是 390deeb4-5e5b-487a-acb9-c2e53dc3f8e9；保留其 SID、原 VM、历史执行与原任务。不得用另一个已通过的 Codex 任务代替。
- 不连接、暂停、终止或删除 Acme VM ihuee6xcl4vvkox0lmpsz。
- 只改 Mikka 应用及获准的 private runtime 代码；保护官方 desktop/claude/codex E2B 模板、别名和官方 CLI。不要手动触发或取消别人的发布。
- 只复用现有 Infisical identities。凭据只留在内存，不能输出或写入文件。
- Node 24、pnpm 10.34.3，使用现有受支持的运行器。不要裸跑共享 pnpm install。保留并行工作树和他人改动。

## 1. 恢复当前执行环境，再完成 UI 门禁

1. 确认平台恢复了当前执行环境及原已登录的浏览器会话。不要创建替代生产 VM 或更换身份来绕过阻断。
2. 先读实际当前仓库的 AGENTS.md 和现有运行器说明。旧工作目录是 /workspace/scratch/cb19aa9d139c；不要操作 /workspace/scratch/61213f03d7af/Mikka。路径是否仍存在需重新核验。
3. 恢复 Cua 后，先调用其文档刷新入口；核对原 Chrome1/cdp 与已有页面，不盲目选择另一浏览器会话。此前生产账号已登录。
4. 取 PR #1207 的最新实际 head 和 main；核实该版本已包含 #1205 与 #1206，完整保留并行变更。按正常 expected-head 合并路径处理任何后续主线变化。
5. 使用仓库现有 local-loop、隔离数据库及受支持身份配置，启动本地 production build（next build / next start）。CI 成功不能代替本地截图。
6. 手动检查并截图：失败 review、失败 verify、重试后的 pending/running、陈旧 list/detail/ledger 绑定、结果未知后重放同 eventId、原 completion recovery 优先级，以及既有 approval/publish 页面。不运行 Playwright 或其他浏览器自动化测试。
7. 负责该变更的 agent 必须实际审阅截图并附到 PR，再按准确 head、实际合并树 CI 与 fresh main 完成正常合并。截图未完成时 #1207 必须保持 draft。
8. 合并后核正常部署 source SHA、READY 和正式域名指向，才开始以下生产 UI 验收。

依据：仓库 AGENTS.md 第10条与其引用的 1520/2225 决策要求 UI 在本地生产构建截图审阅后合并；保留名称为 Browser tests / Production build and browser interactions 的 CI 汇总不代表真实浏览器验收。

## 2. 原 Codex 390：同候选独立重审，不创建替代 producer

### 固定对象

| 对象 | 固定值 |
| --- | --- |
| Workspace | de300000-154f-4875-832f-70e7ffc3b62b |
| Bot | 0c2865c3-7d69-49d2-a3fd-02c484621958 |
| Task | 9ea956ce-a604-4c2e-a724-fb04fa5a3c9b |
| Issue | 65e92e1e-4d75-4531-b1bd-a2a68d7689c7 |
| Request epoch | 531dbd62-042c-4177-9e8a-16d25a46a452 |
| Producer | 390deeb4-5e5b-487a-acb9-c2e53dc3f8e9 |
| Original SID | 01a1a2a5-76f1-7881-b182-311eba17fa98 |
| Current candidate | b251f0b5-3aa6-4e70-b57a-282161c969a1 |
| Expected commit | 8f418086fff9bcd42d17e32de7b7f4a968fdfc0a |
| Existing failed review | d646fc7d-3154-491a-86e0-d27be6b77549 |
| Question / answer | 40c859a6-f048-470d-b036-d6e17feb4765 / 8dac8075-4313-4fca-912c-d6d500bd49f5 |
| Direct predecessor | e57a6d03-510e-496f-bd88-97375318cd9e |
| Original VM | itxw486q7r74fasogje2v |

最后只读状态 06:52:53 UTC：review / failed / revision24；预算按既有 legacy 规则计4次 execute；active Factory runs=0；Owner acceptances=0。这不是下一次操作时的锁，操作前仍需 fresh preflight。

目标文件 factory-1146-codex-d8f3d3f2.txt，UTF-8、无 BOM、LF、85字节：

```text
factory-1146-codex-d8f3d3f2 resume-1146-recheck-6a265954
7 - 4 = 3
verified artifact
```

SHA-256：4e80716f5de244c05cab6f9fdf3d93c90f35fc2cabcf4a07ae79772c48d35032。

### 操作与通过条件

1. 只读复核原 producer/SID/candidate/epoch、当前 revision、active runs、未决 question/operation、验收回执数量及原历史行摘要。不要更改原报告或为零散新窗口重置旧严格 AFTER 的基准。
2. 确认 #1205 预算 guard 和 #1206 历史观察代码已在当前正式 source 中，#1207 已通过截图与发布门禁。
3. 打开原 producer 的线程验收入口，确认显示当前 review 未通过及同一 candidate。只点击一次“重新审阅”。禁止发送通用“继续”让 Coordinator 创建新的 execute。
4. 保存这次正常 UI POST 的 eventId、binding/revision 和真实回执。重试结果不明时先刷新；相同绑定只复用同一个 eventId 和完整请求体。不得因响应丢失自动生成新请求。
5. 必须只新增独立 review/verify attempts，candidate 与 producer 不变，execute 数量不增加。旧 d646 失败结果保留。
6. 新 review 和 verify 都使用 Codex / gpt-5.6-luna / subscription，实际 native claim 绑定 ef66c1d8-2bbc-48e9-abf3-2ce3787ceef5 revision2；禁止 API fallback。各阶段 SID 独立，且不同于原 producer SID。
7. 两个独立检查必须实际读取完整85字节内容、计算 SHA-256、确认提交中的文件与工作区一致、核当前 Git commit，并独立验证 7-4=3。模型报告本身不替代工具结果。
8. 当前390的 records 仍为空。inheritedRecords 只归属 E57：保留其 failed/error 来源、真实观察时间、specific command 的实际退出信息和直接 recovery receipt。不得称为390新执行，也不能满足真正要求 fresh execution 的条件。内部 recovery followUp 不能变成新的 Owner 条件。
9. 全部冻结验收条件与独立检查通过后，再由正常 Owner UI 验收同一 candidate；核唯一、有效认证会话的持久化验收回执，记录实际状态和最终无遗留执行/租约/不明操作。
10. 失败则保留真实结果和证据，诊断具体原因；不得改 criterion、提高预算、覆盖旧记录或创建替代 producer 来获得通过。

原任务的连续性恢复已完成并恢复85字节候选，但本次文件写入时，新的同候选 review/verify 与 Owner 验收尚未执行。

## 3. API a9e472：必须完成新的纯 API 路径验收

截至 06:52:52 UTC，精确标题“Factory 1166 最终回归 API a9e472”的 issue/task/run/API claim/subscription claim/active run/不明操作均为0。现有 key 可列出 deepseek-flash；优先级尚未改成 Flash，不能直接假定自动 review/verify 会走 API。

| 项目 | 固定计划 |
| --- | --- |
| Workspace | 887238ef-410c-4c65-bb08-cfa15e1f8ec9 |
| Computer Bot | d6bf6e81-2ff8-4f2d-ad94-003d94b934bb |
| Existing API key | 782ed1f2-c34a-4be1-971b-fadf6f15238c |
| Harness | claude_code |
| Model | deepseek-flash（允许的 Flash alias；具体版本未独立核实） |
| Coordinator | claude-haiku-5-5 / CC subscription，保持既有冻结设置 |

1. 在外部付费请求前实际运行 `node scripts/assert-test-model.mjs deepseek-flash` 并保留结果。该命令截至交接未执行。不得改用 Pro、其他 provider 或其他模型完成本轮验收。
2. 重新核 exact-case counts、Bot/线程 activity、优先级完整快照及其 fingerprint。已有同标题 case 时先辨识现存任务，不重复建 issue。
3. 用正常设置 UI 把现有 key 的 Flash 条目设为本轮 claude_code 自动阶段的第一适用项；保留原 Pro、Codex、CC 条目，记录自己修改后的 fingerprint。不使用 SQL 改设置。
4. 使用 ../api-a9e472-prompt-v3.txt。它尚未发送。正常 Coordinator 请求必须调用 dispatch_bot_computer，model 为字符串 deepseek-flash；不要再次使用需要 repository 的 dispatch_run。
5. Task 的实际 botId 应从真实数据推导：CC 同类任务的 task.botId 是 Coordinator b56e7f61-59dd-4d7e-a114-b9dddf821a84，而 computer binding 的 Bot 是 d6bf…；不要把两者混为同一字段。
6. 目标 factory-1166-final-api-a9e472.txt，UTF-8、无 BOM、LF、63字节：

```text
factory-1166-final-api-a9e472
9 * 7 = 63
DeepSeek API artifact
```

SHA-256：7b1343eee28f3f545acbf34101d1974630fb710153251a06c218da3154c93fed。

7. execute、review、verify 三阶段均需冻结 API key782/deepseek-flash/claude_code；核实际 model_api_key_runs 三条、native subscription claims 为0，以及三个不同的原生 SID。Coordinator 的独立订阅调用与这三阶段的计费路径分开记录。
8. producer 实际写入并读回；两个独立检查实际核全文、63字节、哈希、提交内容一致与9*7=63；全部条件通过后唯一 Owner UI 验收，保留真实回执。
9. 结束后复核无遗留执行/租约/不明操作。仅当当前设置仍精确等于自己的测试后快照时，才通过正常 UI 恢复先前设置；遇到并行变更则保留并调查，不能覆盖他人配置。

全部验收结束时，还需核验既有证据中的最初测试前配置，完成能够安全归属于本次测试的设置恢复。本轮pre-API快照是当前customized=true配置，不应误称最初默认；不能仅凭早先恢复customized=false的计划覆盖当前设置或并行改动。原始基线不足时保留事实并报告尚未完成的清理，不使用SQL直接重置。

此前准备过的 Pro 提示与 preflight 保留为历史，未用于这项新用例；旧 API 用例也不能替代本次明确路由与实际 claim 的验收。

## 4. CC 已通过的结果与历史失败边界

新 CC 7d2c91 已完成三阶段 Opus subscription 与实际 artifact 检查，Owner于05:43:36 UTC验收。06:52:55只读复核仍 approval/passed/revision12、仅1份验收回执。其源版本和业务 outcome=needs_input、provider alias具体版本未独立观察、producer工具结果单独exitCode缺失等限制均在原 case JSON 中，不能被新文档抹去。

旧严格 physical AFTER（workflow41748854643 / artifact13285320595）仍为 FAILED：hourly judge outcomeAt变化，不能改 collector、阈值、基准或旧行将其变绿。原 d646 review 失败也保留。#1116 离线WIP另行未完成。

所有后续真实结果应追加新证据，并记录准确 source SHA、CI、生产部署、身份/作用域、工具原始事实与 Owner 回执。不能仅凭这些修复部署或模拟/隔离测试，把 #1166 / #1132 标为整体通过。
