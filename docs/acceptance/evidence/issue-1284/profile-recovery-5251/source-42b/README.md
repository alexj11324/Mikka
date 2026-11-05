# #1284 Profile 恢复与诊断：增量验证证据

此目录是供审查和后续 GitHub 发布使用的脱敏增量。它不修改已有 `4dd53` 证据，也不把历史红灯改成绿灯；本次整理没有 push、重跑测试或修改产品源码。

## 版本链

- 初始诊断与 Review 隔离：本地 `250ab8e1b603eae07bcdbf25bb8fee3be54fcd1e`，tree `98a6fd10e40153fecbbb346f0bc29ef3501910ca`；发布为同树的 `6f400d1b0851abbe823983ddd3a1d1ff9eb95725`。
- 严格 claim 夹具补齐真实模块：本地 `ecb1bc4b6a3c40d19baf2d8a483982815db9b429`，tree `ab1e3c73744a5fe2d920136978af865f8bff8317`；发布为同树的 `7e23a2326fb2b4e849562e03cb263ad32be37c2e`。该 source PR 的 CI 41988364745 已完成，18 个 checks 中 17 success、1 OIDC skip。
- 最终融合：[#1358](https://github.com/alexj11324/Mikka/pull/1358)，HEAD `42b1f3f5f2a19f1271e3e513a77b2b046c99d662`，tree `002ef49edfc7150fe0b56200d8f77296db5e519c`。本地整合签收 `82c9725b…` 同树；下面的最终测试均实际在发布后的 `42b` 执行。

## 文件

| 文件 | 内容 |
|---|---|
| [01-source-changes.json](01-source-changes.json) | 生产现象、诊断与事务隔离范围、原始受控工作树测试和保留的红灯 |
| [02-fixture-ci-repair.json](02-fixture-ci-repair.json) | 6f CI 的五个严格导入失败、两行夹具修复、90 项红绿及 source7e CI |
| [03-fused-verification.json](03-fused-verification.json) | exact42b 的六组 276 项、UI 91+44、types/lint、文件指纹与清理记录 |
| [04-environment-and-open-acceptance.json](04-environment-and-open-acceptance.json) | 环境中断、备用仅 bootstrap、batch CI、独立 main 红灯、完整构建及尚未完成的验收 |

## 已取得的结果

六组串行验证共 **276/276，零失败、零跳过**：Profile-dispatch 45、completion-reconcile 34、checks 71、contract 10、strict claim 26、self-improvement 90。前三组共 150 项真实隔离 PostgreSQL 验证，后面三组共 126 项单元／路由夹具验证。融合后的 benchmark 夹具含两侧改动，因此其 90 项在最终版本重新执行，没有复用 source7e 的结果冒充融合测试。

另外，exact42b 重新执行的 UI 源码测试 91/91、thread controls 44/44，以及 types、UI lint、定向 oxlint 均通过。正常 `pnpm build` 于 07:59:36–08:01:32 UTC 完成，exit 0；08:01:36 server ready 并通过严格环境 attestation。这些结果不代替正常 HTTP 业务流、截图审查或生产模型验收。

GitHub 08:01:49 UTC 的只读快照显示 batch CI 41990240365 完成 success；该 head 总计 32 checks，27 success、5 skipped。文件保留每个 check 的真实状态。CI 中包含 “browser” 或 “publish” 的名称不被解释为本证据完成了浏览器验收或跳过的发布动作。

## 必须保留的边界

**ALEX66 原始首次 claim 的根因仍未知。** Profile claim 变更只补充安全因果与闭集合诊断，不更改权限或拒绝条件。模拟的继承模型／JSONB／设备交接／缓存过期首 claim 通过，不能证明原生产故障已修复。

ALEX67 的 pre-Run Review Decision 拒绝传播到整个 Coordinator 是独立、已复现的功能缺陷；事务隔离回归已通过。34 项 completion 用例直接调用 `handleFactory` 领域 HTTP handler，使用合成 actor；**没有经过 Next route/session adapter，也没有通过真实监听的 HTTP 服务**。正常 HTTP 验收单独记录，不从这些测试推断。

主干 `7cae54d3…` 的 CI 41990588417 仍保留真实 daemon 红灯：撤权测试读取临时 `sigterm-exit` 标记时 ENOENT，950 项为 947 pass / 1 fail / 2 skip。同 SHA 的 Publish job 自己的 950 项为 948 pass / 2 skip，但随后正确因 `releaseCheckFailed:ui-policy.yml` 拒绝发布。相关 fixture 与 supervisor 在 main7cae 和 batch42b 字节相同；具体时序根因未定，不能说两行 claim fixture 修复解决了它。

产品验证均在同一原 Docker 沙盒进行：部分源门禁发生于中断前，最终融合门禁发生于恢复后。备用 Docker 只安装基础工具、Node 和 pnpm，未创建仓库、数据库或执行产品／模型测试；07:33:48 UTC 已观测为 STOPPED。六组 276 项后端门禁所建的 PG 角色和数据库已在零会话后正常清理，无 FORCE 或终止后台进程；HTTP／截图专用环境另行记录。

正常 Next/session HTTP、截图与生产 Claude Code／Codex 验收仍等待各自证据。API DeepSeek 路径按 Alex 明确指令跳过：用户已声明余额不足，本轮没有付费请求或余额探测。

本公开包只含版本、验证类型、计数、闭集合错误码、公开 GitHub 链接和日志哈希；不包含原始账户、数据库 URL、凭据、cookie、私有 Profile 指令或完整日志。
