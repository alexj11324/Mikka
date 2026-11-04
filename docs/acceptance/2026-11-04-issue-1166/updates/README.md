# #1166：后端修复已部署，剩余真实验收仍被执行环境阻断

截至 2026-11-04 06:52–06:53 UTC 的独立只读复核，#1166 / #1132 仍未整体验收完成。本目录是新增证据，不能将修复部署或 CI 成功等同于原任务通过。原有20份证据文件及旧失败记录保持不变。

## 当前真实结果

| 对象 | 已确认的结果 | 尚未完成 / 限制 |
| --- | --- | --- |
| 新 CC 7d2c91 | 三阶段使用 claude_code / claude-opus-5-5 subscription，实际写入并独立检查65字节文件；05:43:36 Owner验收。06:52:55复核仍 approval/passed/revision12，唯一验收回执 | 本次读取没有重跑模型。业务 outcome=needs_input 保留；具体 provider alias版本未独立观察；最新CC截图未取得可用文件 |
| 原 Codex 390 | 原 producer、原SID和85字节 candidate已恢复；真实独立审查曾核对完整内容、哈希、Git与算式 | 06:52:53仍 review/failed/revision24，预算计4次execute，0 active run、0 Owner验收；新的同候选review/verify尚未执行 |
| API a9e472 | 现有key782支持允许的 deepseek-flash alias；06:52:52精确case的issue/task/run/API claim/subscription claim等全部为0；优先级fingerprint未变 | 提示未发送，模型政策assert未运行，自动阶段的模型优先级还未切至Flash，不能记作通过 |
| #1205 预算门禁 | 已合并，06:33:28正式应用READY；所有适用CI通过 | 防止同epoch通用续跑绕过repair预算；没有据此重试原任务 |
| #1206 历史命令观察 | 已合并，06:41:53正式应用READY；正式域名source为aa50444…，main CI成功 | 只增加可追溯历史观察；不产生自动pass，不把E57命令记作390新命令 |
| #1207 同候选重审UI | 已正常继承#1205/#1206；最终17 checks中16成功、1条件跳过；72项交互单元回归全部通过 | 仍为draft，未合并/部署。本地production-build实屏截图BLOCKED，CI不能替代 |

CC的完整实际native claim、独立工具结果、字节数/哈希、Owner事件、真实成功及失败过程见 [原CC case](../cases/cc-7d2c91-owner-accepted.json)。原390的冻结目标和旧失败见 [原任务 case](../cases/codex-390-recovery-incomplete.json)。其他已完成的旧用例不替代上表未完成的原390或新API验收。

## 本批修复解决了什么

### #1205：预算耗尽时保护当前候选

隔离 PostgreSQL 的测试先行版本确实复现了 pending review 窗口的预算绕过：通用续跑原本可以清除候选并创建新execute。原 failed review 路径当时已被后续 ancestry 校验拒绝，不能把它也说成已成功创建新producer。

修复在同一事务内先用 canonical task lock 复核权限，再复用现有预算检查，预算通过后才执行repair。原策略仍是首次执行加3次修复；明确、受认证的新Owner请求仍可进入新的epoch。最终目标套件178通过、0失败、0跳过；四PG分片运行66个必跑套件。没有在生产执行预算绕过。

发布source：185a91bd0dafb5717ef69fb6589ec0251b3115f6。详见 [完整发布证据](factory-continuation-budget-release.json) 和 [PR #1205](https://github.com/alexj11324/Mikka/pull/1205)。

### #1206：把真实历史命令以正确归属交给独立检查

新helper只接受由唯一直接question_recover回执证明的前序执行。它复核原execute attempts、明确epoch回执、canonical human answer与时间顺序、SID、设备/仓库/agent/base/worktree，以及冻结配置和两端实际native claim。合规的个人凭据custody workspace与执行workspace可以不同。

390的当前records仍为空。E57的历史命令单独放在inheritedRecords，保留source run、SID、时间、失败来源与specific tool output，不增加passed字段。历史观察不能满足真正要求fresh execution的条件；新review/verify仍须检查当前固定candidate的完整文件、哈希、Git和算式。

测试先行版本在fixture正常建立后因缺失inheritedRecords而失败。首轮unused import/23514仅是fixture错误，已单独保留。最终37个新增子用例全部通过，所属脚本110通过、0失败、0跳过；错误身份、receipt、epoch、实际claim、截断、超过32对或总量12k等边界均拒绝或明确省略，失败退出码原样保留。

发布source：aa50444a0b5012d2d35ca730c3ca722c0057d596。详见 [完整发布证据](inherited-observations-release.json)、[生产只读shape核验](inherited-observations-production-shape.json) 和 [PR #1206](https://github.com/alexj11324/Mikka/pull/1206)。shape核验不等于已运行生产TypeScript helper，也不等于生产review通过。

### #1207：Owner可以重审同一候选

草稿让失败和待运行的review/verify在原候选线程可见；重审前必须让list/detail/ledger和最新failed attempt的绑定完全一致。点击时同步防重入，结果未知时保存完整eventId与reason；刷新不自动重发，后续revision也必须再次显式点击。

代码审阅发现并修复了两项问题：请求结束后同时刷新任务列表、详情和验收记录；格式异常的HTTP200不能当作已确认成功。后者要求canonical same-candidate、新pending attempt的回执，缺失时保持“重试未确认”。

最终head：6273413b921f0747a40e9fc8f98033b325ff32f0；基线aa50444…；真实synthetic tree与head一致，8个UI补丁blob完整保留。72项为node:test/happy-dom、带模拟网络的单元回归，不能称为真实浏览器或生产验收。见 [草稿验证记录](retry-ui-draft.json) 和 [PR #1207](https://github.com/alexj11324/Mikka/pull/1207)。

## 发布与保护约束

06:47:32独立核对正式域名app.aspectlylabs.com指向dpl_3w4SnCqaoFhayN8QCU6UGc4vuARw，source为aa50444…且READY。官方private runtime的wanted/live digest均为0920b72…，正常跳过validate/publish；受保护的官方E2B模板及其别名、Claude/Codex官方CLI代码未修改。daemon 0.0.427正常发布并核同commit；Desktop在最后观察时仍打包中，不能据应用READY声称它已发布完成。

没有手动触发或取消发布，也没有在本批部署观察中操作原任务、VM或发送模型请求。文档中的零操作范围限定于对应补丁/观察期间，原有生产重试、失败及CC成功记录不会被抹去。

旧严格physical AFTER（workflow41748854643 / artifact13285320595）仍为FAILED：hourly judge outcomeAt变化。没有重置collector、基准、阈值或旧行，也没有用新的局部读取窗口替代旧失败。旧d646 review失败、#1116离线WIP均保留。

## 仍需执行的工作

执行环境在06:31:27明确返回“No usable execution environment is available”。因此，下一步必须先恢复当前执行环境与原已登录浏览器会话，再完成：

1. #1207的本地production-build实屏截图及负责agent的实际审阅，随后正常合并发布。
2. 原390同candidate的真实独立review、verify与唯一Owner验收，保护原producer/SID/VM和旧记录。
3. API a9e472的Flash政策assert、正常模型设置、三阶段真实API key claim、完整产物检查和Owner验收；结束时仅在设置仍等于自己的测试后快照时恢复，保留并行变更。

完整步骤、固定对象、字节内容、SHA-256、正常UI入口与保护条件见 [恢复执行计划](resume-plan.md)。最新三个case的只读事实与设置fingerprint见 [生产状态快照](latest-production-readback.json)。

本目录的manifest记录新增文件的Git blob SHA。它没有覆盖原证据，不代表未完成步骤已经执行。
