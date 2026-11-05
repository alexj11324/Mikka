# #1284 生产验收增量与 due-timer 检查点

本包按各收据的实际时间、提交和执行范围记录证据，**不是一个新的产品发布，也不表示 #1284 已全部完成**。

## 正常 Owner 生产操作

- [322 发布收据](receipts/issue1284-main322-release.json)：Web、daemon 和官方 runtime 的实际发布结果；daemon 为 `@aspectlylabs/mikka@0.0.470`。这是 322 的记录，不改标后续 main。
- [ALEX66 Stop](receipts/issue1284-production-front-stop322.json)：正常 “Try stopping again” 使原受阻 Run 进入 stopped；此步骤本身没有执行模型。
- [ALEX66 双订阅与修复](receipts/issue1284-production-front-cc-codex322.json)：Front v1 的 Claude Code / `claude-haiku-5-5` 实现，随后独立 Review v1 的 Codex / `gpt-6-luna`，都实际通过官方订阅运行。Codex Run succeeded，但业务 Review 因浏览器渲染未验证而 failed；自动 CC repair 完成后，生产报告仍记录 Headless Chrome SIGABRT。仅凭该原收据，不能宣称视觉验证或 Owner Accept 已通过；后续独立检查另行记录。
- [ALEX72 显式选择、版本冻结与接受](receipts/issue1284-production-explicit-freeze72.json)：正常 New task 显式选择 Front v1；保存 Profile v2 后，原 Run 的非终态 finishing 读回仍保留 v1/digest 和原 Harness/model，随后完成。独立 Codex Review 两项标准通过，Owner 于 14:34:24 UTC 正常 Accept，Task 变为 passed/approval。只证明收据中的时间关系，不声称保存动作覆盖整个 60 秒等待。该原件记录 ALEX73 当时 pending，不回写历史状态。
- [ALEX73 新任务采用 v2](receipts/issue1284-production-explicit-v2-73.json)：后续正常 Owner 消息授权派发已创建的同一 Issue；实际 CC Run 采用显式 Front v2/digest `2d28a80…`。独立 Codex Review v1 两项标准通过，Owner 于 14:42:08 UTC 正常接受，Task passed/approval。这份后续记录补齐 v2 新选择结果，没有创建重复任务或增加 Verify。

[ALEX72 实际 Owner 接受截图](visual/issue1284-owner-accepted-alex72-1793889302861.jpg) 显示 Accepted 和 Done。图片与收据记录的 98,457 bytes、SHA-256 一致；图片不单独代替 Run、模型、权限或冻结配置的结构化证据。

候选 SHA 与检查 Git SHA 分开记录：ALEX66 的两个 candidate 对象均 `sha:null`，`78cbd…` 仅是原 Review 的 `output.check.sha` / `completion.check.sha`。ALEX72 的 candidate 也为 `sha:null`，`979c…` 是其 Review 检查 SHA。文件字节数与 SHA-256 用于确认真实产物，不能拿工作区 Git HEAD 覆盖 candidate.sha。

页面公开版本与持久 Workflow 的实际执行部署是不同证据。ALEX72 收据中的 325 是一次公网版本观察，不据此推断每一个 durable Workflow 都执行该版本。

## ALEX66 后续独立产物检查

从正常生产 Changes UI 提取的 [status-card.html](render/source/status-card.html) 只恢复末尾 LF，结果严格为原产物的 **1,486 bytes / SHA-256 `ec901cd906938c2d903ac81afa19345f2f05b3a9e23a1659770c7d66d088dad8`**。现有 Docker Chromium 156.0.8078.4 在离线、无样式覆盖条件下实际打开同一文件，产生 [1024×768](render/captures/status-card-ec901cd9-1024x768.png) 和 [400×800](render/captures/status-card-ec901cd9-400x800.png) 两图；桌面三列、手机单列，无裁切或横向溢出。

[实际采集 manifest](render/captures/capture-manifest.json)、[独立 assistant 复核](render/independent-assistant-visual-review.json) 和 [root assistant 复核](render/root-visual-review.json) 分别保留来源及范围。此步骤是对真实交付文件的独立 Docker 检查，**不是生产原生 Chrome 执行成功或 SIGABRT 已修复的证明**；没有强制第二次 Review，没有改写原 Review failed，也没有启动应用、数据库或模型。两图采集后 browser/context 与自有子进程均关闭。

[ALEX66 后续 Owner 接受收据](receipts/issue1284-production-front66-owner-accepted.json) 记录：在上述独立检查后，正常 Owner UI 补充证据评论，并于 14:49:20 UTC Accept；Task revision 20 为 passed/approval，14:50:14 的正常 GET 再次确认。历史 Review 仍是 failed、次数仍为 1；完成的是修复产物经补充检查后的人工验收入口，不是把旧审阅改成通过。

## 未发布的 timer 检查点

[完整 33 文件检查点](checkpoint/README.md) 保存本地提交 `a2c5280934bd5078dc77702e1d3a16f3f4ca4b26`（tree `4bc8f0a1dbf391a4b20e422b96774ec7593f4d40`）的源码、原始红绿日志与版本边界，用于向 [权威修复 PR #1403](https://github.com/alexj11324/Mikka/pull/1403) 交接；它不是第二个待发布实现，没有推送为产品 PR。

[validation.json](checkpoint/validation.json) 明确保留：较早的 70 项 unit/contract 和 15 项 PG 结果只绑定当时的 diff；最终 election/loop 回归是 **12/12**。最后新增的结构化 diagnostic 断言仍 pending，不声称最终整树 type/lint/unit 全绿，也没有为此检查点执行完整构建或生产迁移。[DB 清理收据](checkpoint/db-receipt.json) 记录自有测试库/角色正常删除、会话为零，没有 FORCE/terminate。

Workflow cancelled/终态不证明已经运行中的旧 step 立刻终止。timer 的真实跨部署恢复仍由 #1403 后续正常发布和原任务验收证明，不能用本检查点测试替代。

## 范围与隐私

本次证据打包、图片核对与官方静态审计不调用生产接口、模型、provider 或数据库，不启动应用。未执行 DeepSeek coding API 测试；生产中正常使用的 builtin Decision 不属于用户排除的 coding API 路径。

原收据保留各自已证事实及未完成项；不因后续案例成功而改写此前失败。私有 Profile 指令、密码、cookies、原生 session 值、签名密钥和审计 ledger 不进入公开包。manifest 与官方审计报告单独发布并绑定本包确切文件字节。
