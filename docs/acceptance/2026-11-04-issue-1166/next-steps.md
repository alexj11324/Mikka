# #1166 下一步：保留原 producer，完成剩余真实验收

状态：方案与正在准备的修复，不是生产验收通过。以当前 main 和实际 receipt 为准，任何新发布都需重新绑定版本和证据。

## 1. 封闭通用 continue-repair 的预算绕过

已证实的路径是 Coordinator dispatch_run / dispatch_bot_computer → existing producer thread → queueFactoryTask → continue-repair。现有分支在同 epoch 的 review/verify failed 或 pending 状态可进入 store.apply('repair')，没有复用其他自动 Factory 路径已有的预算门禁。本案当前 failed + trustedFailureProvenance=true 还会被后续 repairAnswerCandidate 的 ancestry guard 拒绝，不能声称这个 failed 状态必然提交新 producer。真实风险窗口是 Owner retry 后的 pending：它不进入 failed-check ancestry guard，通用续跑可能清候选并新建 execute。

最小建议是 lib/factory/task-dispatch.ts 在既有任务/advisory 事务锁内、整段 continue-repair 调用 store.apply 之前，调用 checkFactoryRepairBudget。不只保护 failed：Owner retry 刚创建的 pending check 也需要保护。合法的新 Owner thread_continuation 已先经 advanceFactoryRequest 进入新 epoch / execute，不应被旧 epoch 的计数误伤。

风险估计：发生 6/10、影响 9/10，乘积 54；这是基于已确认可达路径的工程分级，不是统计概率。

必要真实 PostgreSQL 回归：耗尽预算的 failed 和 pending 均不产生新 execute attempt/run、不清候选；预算内原流程可用；明确新 Owner epoch 可用；旧 Owner/权限/事务门禁保持。此 queue 层 guard 不应夸称整个通用 dispatch 零 provider 调用，因为 runtime preparation 可能发生在 queue 之前。

## 2. 展示严格绑定的直接前驱命令观察

保留现有 records 表示当前 producer 的记录，390 本案仍为空。新增 inheritedRecords 必须逐条标注 sourceRunId、sourceSessionId、原观察时间、inherited=true、sourceStatus=failed 和 recoveryEventId，不新增自动通过位。

只接受唯一 direct question_recover 收据，绑定原 source 和 producer execute attempt；explicit receipt epoch 必须匹配，不能将 null attempt epoch 通过 COALESCE 假作历史证明。复用 canonical human answer reference/fingerprint，检查 answer → 命令 → 恢复收据 → producer 的顺序，以及设备/仓库/agent/base/worktree、冻结与实际 subscription binding 的一致性。拒绝 recursive repair/retry/sibling 继承。

当前 candidate 的 resolver 和 retained snapshot receipt 仍必须验证；review 和 verify 仍各自实际 inspect 正文、bytes、SHA、committed SHA、HEAD、Git 和算式。历史记录不能满足明确的新鲜执行要求；实施前须区分真实 Owner criterion 与内部恢复提示，不改写任何旧输入。

必要回归：本案形状的 legacy null epoch + 唯一显式收据可展示；错收据/重复收据/错前驱/跨 epoch/owner/device/account/binding/candidate、answer 前命令、坏时间窗口、缺失或截断配对均不能形成可通过观察。读取旧记录不得改 report/question/run/candidate/receipt。

不需要为展示历史观察再接触 VM、重建 checkpoint 或运行旧 frozen collector。若严格身份门禁缺证据，应明确拒绝继承。

## 3. 正常 Owner 同候选重审入口

现有 Human action=retry 保留 stage/candidate 并创建新独立检查 attempt。现有验收列表隐藏 failed review/verify，使 Owner 无法通过页面使用它。最小 UI 范围为 acceptance 两组件、纯显示 helper 和双语文案；不新增后端 action。

有当前候选的 failed/pending/running review/verify 应在原候选线程的验收页可见；只有严格匹配当前 task/candidate/attempt/revision 的 failed 状态提供“重新审阅”或“重新验证”。使用 revision-bound 的现有 retry、固定幂等 eventId、busy 互斥和刷新。未知网络结果沿用同 eventId，不对变化后的 revision 自动重发。

retry → pending 由既有 watchdog 正常调度，同候选只读检查不需要 Decisions 选择 repair。先完成第 1 节保护，再做原任务生产重审；不能靠“这次会通过”保证不新建 producer。

UI 必须遵守仓库设计和本地 production build 截图审阅门禁；不运行浏览器自动化测试。当前执行环境不可用，因此不能声明这项 UI 验证已完成。

## 4. 原 Codex 生产验收顺序

重新核 task 9ea956ce-a604-4c2e-a724-fb04fa5a3c9b、epoch531、candidate b251、producer390、原 SID、VM custody、无活动/不确定操作及保护行指纹。确认部署精确包含经过 CI 的补丁后，由 root 唯一执行正常 Owner 同候选重试。

重试只允许新增独立 review/verify，不能创建替代 producer、改旧 report、改 q40c/answer/C7/E57 或换账号/模型。两个检查必须真实独立检查当前85B候选；全部通过后，唯一 Owner UI 验收并核认证 receipt。任何缺证据仍应保持未通过。

旧 strict physical AFTER=FAILED 保持，新的功能验收以新 observedAt 单独记录，禁止修改旧 baseline/collector/阈值或恢复数据库历史行。

## 5. 新 API 路径

先确认 CC 任务已通过且没有活动后续，读取优先级指纹和并行活动。通过正常 UI 将既有 key 的 deepseek-flash 条目放到同 harness 的 CC 条目前，保留其他 DeepSeek Pro 和 Codex 条目；重新读取确认，没有并行写入冲突后，再创建唯一 a9e472 issue 并调用一次 dispatch_bot_computer。

使用 claude_code、deepseek-flash、现有 keyId 782ed1f2-c34a-4be1-971b-fadf6f15238c。06:00 窄 SELECT 已确认该 key 列有 deepseek-flash；此前 Pro 方案从未派发。付费测试前必须实际运行 node scripts/assert-test-model.mjs deepseek-flash，当前环境不可用，尚未执行该命令。实际文件63B，SHA 7b1343eee28f3f545acbf34101d1974630fb710153251a06c218da3154c93fed，9 × 7 = 63。三阶段需三个独立原生 SID、实际 API key claim、subscription claim 0，review/verify 各自完整 inspect，最终正常 Owner UI 验收。

模型提供方未暴露的 alias/version 遥测保留 unknown；不能从自述或冻结模型 ID 推断额外实测。设置恢复仅在仍等于本次写入指纹时执行，保护其他人的并行变更。
