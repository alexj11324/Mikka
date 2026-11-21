# #1783 生产真实任务验收

本页供持有 #1752 发布窗口的发布者运行 #1783 验收并核对回执。入口是
`Factory visual evidence production acceptance` GitHub Actions workflow，
代码为 `scripts/acceptance/factory-visual-evidence.mjs`。

## 运行前提

PR #1789 的最新 head CI 全绿，普通 merge 后的提交必须同时是 main、
`/mikka/api/version` 返回的 build，以及完成发布的 E2B runtime 来源。
已有 Infisical GitHub OIDC 身份仅在 main 受信 runner 内读取
`SMOKE_OWNER_EMAIL` 和 `SMOKE_OWNER_PASSWORD`；不把凭据拉到本地。

测试账号必须已有共享 Claude Haiku 5.5、Codex GPT-6 Luna 订阅与正常
访问 `alexj11324/Mikka-handoff` 的 GitHub 连接。driver 从实际账号的
正常 API 发现这些权限，不创建连接或借用另一人的身份。缺账号、订阅或
GitHub 授权时，该 case 保持失败；在 issue 写明缺项后继续其他已授权工作。

## 登记并运行

1. 读 #1752 最新评论及 E2B release 状态，确认没有其他实际窗口或运行中的
   runtime release，再登记开始和最晚结束时间。
2. 在同一窗口评论写入以下 machine marker，填入 **PR 最终 head** 与
   最晚结束的 UTC ISO 时间。`expiresAt` 必须在当前时间之后且不超过两小时：

   ```text
   <!-- mikka-factory-1783 {"state":"active","issue":1783,"pr":1789,"headSha":"PR_HEAD_SHA","expiresAt":"END_ISO"} -->
   ```

3. 普通 merge PR #1789。Web deploy 和 E2B additive runtime release
   完成事件会触发只读选择器；若 Web 先结束，选择器等 E2B 完成事件再选择。
4. 如需手动运行，从 main 调度 `factory-visual-evidence-acceptance.yml`，
   输入 `application_sha=MERGE_SHA`、`window_comment_id=COMMENT_ID`、
   `model_case=all`。先前成功的同源 case 只从对应真实成功步骤复用；诊断修复
   后重跑失败 case，不靠随机重跑消除失败。

`PR_HEAD_SHA`、`END_ISO`、`MERGE_SHA` 和 `COMMENT_ID` 分别替换为该 PR
最终 head、窗口结束时间、merge 提交和窗口评论 ID。driver 每次写入前
重读窗口；窗口结束后拒绝新业务写入，但继续清理自己的资源。

## 核对真实业务回执

Claude case 使用正常 Bot computer 与正式 desktop 模板。第一次实际
`submit` 不携带媒体，必须持久化 blocked 门禁；正常 Owner accept 入口
必须返回 409 且 revision 不变。随后同一 thread 的 continuation 创建
真实文件，在 Chromium 中读取和重载，并录制视频、截图。正常 MCP 上传
完成后，独立 review 通过并由 Owner 接受。

Codex case 使用已授权的 Mikka-handoff 仓库与正常 repository dispatch。
它只新增一个带本次 nonce 的文本文件，提交一次，使用指定 branch 创建
自己的未合并 PR，并通过既有仓库检查。临时浏览器依赖和媒体位于该 run
的 capture 临时目录，不能进入 Git diff。生产验收不合并这个测试 PR。

两个 case 都从同一次 activity 快照选择当前 producer、candidate 与
不可变报告版本。driver 通过 task media 和报告链接分别下载原字节，核对
SHA-256、大小、同源路径并解码每份媒体。Codex 在核对 handoff 后正常
取消测试 task，再确认保存的报告和媒体身份、版本、字节仍完全一致。

从 Actions artifact `factory-visual-evidence-RUN_ID-RUN_ATTEMPT` 核对：

- `report.json`、各 case 报告和 `index.html`，包括真实 task/candidate/run。
- 缺证据门禁和 Owner 409、当前候选的报告与媒体绑定、实际 native 命令回执。
- 录制文件、结果截图、下载的不可变报告与完整媒体解码结果。
- profile 与 credit share 恢复、run 和 VM 终态、工作区恢复、会话退出结果。

`RUN_ID` 和 `RUN_ATTEMPT` 替换为实际 workflow run 与 attempt。测试 task、
Bot 和审阅证据保留供查看；临时 profiles 被归档，runtime 资源结束。

Codex 报告中的 `directGitHubRead` 保留
`pending_operator_connector_verification`。在关闭 issue 前，用正常 GitHub
读取通路核对其实际 PR URL、仓库、head、author、最终 issue marker 和
checks，并记录它仍未合并。host 的 publication 投影不能替代该读回。

## 释放窗口

最终回执同时写明服务版本、这次 merge 自动触发的 E2B/R7 终态、实际任务
结果和清理结果。只有这些结果及直接 GitHub 核对闭合后才声明完整生产通过。
把回执贴回 #1783 与 #1752，立即以 `state:"released"` 更新本次 marker
并释放窗口。失败仍保留原始失败事实和脱敏回执，修复后再验收。
