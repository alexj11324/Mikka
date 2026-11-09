# Trusted carrier: exact-child cleanup preparation

状态：**仅本地预制，未绑定、未激活**。所有 19 项动态 pin 均为 `null`；工作流为 `.yml.in`，job 为 `if: false`，首段在网络或 OIDC 前拒绝未填 marker。这个包不创建 child，不执行 cleanup，不建立新的用户门槛或生产 hold。

固定载体为我方已经实际使用的 `ops/1505-smoke-github-readonly-20261109`，GO 为 `root-reviewed-1505-github-r7-20261109-v1`。这里不更改 workload 身份、授权或 trust，也不把“分支名称存在”当成新的信任证明。使用背景来自 root 已核实的原 C9 五项 OIDC 成功记录；本任务没有重新查询身份或生产。

## 为什么修改原源码形状

原 `readonly-r7-preparation-1505/cleanup` 的关闭入口假定是本次 child prepare 的关闭 head，并要求 cleanup 是该 head 的单父、仅修改一个 workflow。共享载体以后还会承载 H prepare/cleanup，因此那条默认父链不能沿用。

本包只允许以下一种形状，不自动退回旧单父模式：

| 项目 | 新的精确合同 |
| --- | --- |
| 第一父 | `currentMainSha`：清理交接时明确选定的实际 APP/main 完整 commit |
| 第二父 | `cleanupClosedCommit`：当时该自有载体的实际已关闭 head，可以包含 H 生命周期历史 |
| 父顺序 | 严格 `[currentMainSha, cleanupClosedCommit]`，无第三父、无换序 |
| 已关闭载体树 | 必须与 `cleanupClosedTree` 一致 |
| operator 树底 | 使用第一父 APP 的完整树；其 commit SHA 已不可变绑定树，无需第 20 个 pin |
| 相对 APP 差分 | 恰好六个新增路径，全部 `A / 100644 / oldOID=0`；不允许修改、删除、重命名或额外文件 |
| 正常 FF | 第二父保留实际 closed carrier 为祖先，root 可在再次核对 expected head 后普通 FF |

六个路径是同名 cleanup workflow，以及 `scripts/ops/issue1505/` 下的 provider、helper、store、runner、test 五文件。不能把 carrier 的实际树作为基底再继承其 H 或旧 C9 文件。若未来选定 APP 已有这些路径，当前 adds-only 合同会拒绝；必须先审具体冲突，不能静默放宽成任意修改。

`cleanupClosedCommit` **不是**默认的旧 C9 关闭 head，也不是默认的本次 child prepare-close head。本包不填任何这样的实际值。它只校验被绑定的精确 commit/tree/父链；是否已经关闭、相关 consumer 是否已收尾，仍必须由 root 在真实交接时从该载体的实际入口和元数据确认，不能从名称或一个历史 receipt 推断。

## 19 个未填 pin：两个身份域保持分离

| 身份域 | 字段 | 含义 |
| --- | --- | --- |
| 本次 child 原 prepare | `prepareRunId`, `prepareRunAttempt`, `prepareWorkflowId`, `prepareHeadSha`, `prepareBranch` | 绑定产生这个 child 的实际成功 run/attempt；branch 必须是本 trusted branch，attempt 必须为 1 |
| 原始 artifact | `artifactId`, `artifactName`, `artifactBytes`, `artifactDigest`, `zipSha256` | 绑定同一 prepare 的唯一原 ZIP，元数据与实际字节一致 |
| 原始 state receipt | `receiptBytes`, `receiptSha256` | ZIP 内唯一 `receipt.json` 的真实原字节；不改写 state |
| 新 cleanup 执行源码 | `cleanupClosedCommit`, `cleanupClosedTree`, `currentMainSha` | 当前 closed carrier 与新 operator APP 身份，独立于原 prepare source |
| 新 cleanup 窗口 | `windowStartUtc`, `entryDeadlineUtc`, `hardEndUtc`, `jobMinutes` | 新明确窗口；预算仍为原 1–15 分钟范围，无默认延长 |

特别是，**不能把原 child 的 prepare head/run/artifact 换成 cleanup APP 或 H 的 source**。receipt 本身没有 main source 字段；跨 main 只重新绑定 operator 的 APP/父链/三处 current-main/window guard，精确 state、token digest、连接身份和原始 receipt hash 仍保持原值。

实际 APP 在本模板中就是 `currentMainSha` 所绑定的当前 main。三次 fresh main GET 必须等于它；本包不暗中选择已过时 APP，也不把 prepare 时的 main 当作清理时的 main。

## 不变的执行合同

- trusted prepare 的五脚本逐字复制，尤其 runner SHA `7859cff4714d5367a29322357bd9945ab8c9c49376c3312d4b8643facaff0f57`、test SHA `a29271758aaa0cc9ed3eac3a8e9ae05f96c91bf955ef48cb97f8490ff8f6a1c2`。没有修改 provider/helper/store/runner/test 的行为。
- source run 与 exact attempt 两次元数据读取、artifact 身份、ZIP 下载重定向规则、精确大小/hash、单成员 regular receipt 验证均沿用原实现。`source_matches`、`download_archive`、`verified_receipt` 逐字保持。
- 原五项 OIDC 连续区块逐字保持：`prod:/neon DATABASE_URL`；`prod:/vercel` 的 `MIKKA_DATABASE_URL`、`BETTER_AUTH_SECRET`、`GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`。没有新增 scope、key 或身份。
- 原两队列 `production-smoke-owner-acceptance` 与 `web-deploy-production`，`cancel-in-progress: false`、`queue: max` 保留。三次 current-main GET、四份窗口函数、七次窗口检查保留。
- `cleanupReadOnlyConnection` 仍先校验 state/app、正常身份和 idle；只从匹配的 Smoke 连接取得 exact child，再按 digest 校验。只撤销这个 token，绝不 `/grant`、Owner token 或其他 child。
- provider 的 DELETE204 或认证 Check-token404 仍是原撤销证明；随后在事务/行锁下重新匹配 exact state 并调用正常 `disconnectGitHub(SMOKE_USER_ID)`、COMMIT。正常 prepare `saveGitHubConnection` 和所有原字段约束未改。
- cleanup 分支不运行 prepare 或 Owner refresh；缺 token、连接变化、撤销未确认、commit/close/receipt 保存不确定时保留 incomplete/unknown，不猜测已清理。
- 原 runtime cleanup 与 always receipt 上传尾段逐字保持。只使用本次新 child 原 state，不复活旧 C9，不拿其他 owner 的 child 作为对象。

## 实际交接顺序

1. 待实际 consumer 结束，由 root 确认该 child 的合法使用已结束，并关闭当前 carrier 正在承载的入口；即使最后一轮是 H cleanup，也绑定那个实际关闭 head。
2. 从本次新 child 的成功 prepare、exact attempt、artifact 和原始 receipt 填入前 12 项 provenance pin。填真实字节/hash，不修改 receipt 内容。
3. fresh 核 APP/main 和 closed carrier，填写三个源码 pin。以 APP 树新增六文件，构造固定有序双父；不带 carrier 的其他文件。
4. 填新窗口和 job 预算，核 `start < entry`、`entry + jobMinutes <= hardEnd`。重新计算实际绑定后的源码/hash；模板 hash 不代表最终激活源码。
5. root 审最终 source/metadata/账号空闲与原 5 scopes 后，才单独将禁用 job 改为已列明的 repository/ref/attempt 条件并普通 FF。这里没有激活权限或自动发布步骤。
6. 真正运行后依据 exact revoke/disconnect/receipt 和终态收尾，再关闭入口。这个准备包不证明上述任一步已经发生。

## 本次有限离线验证

真实执行了 `python validate-offline.py`：七段内嵌 Python compile、YAML 语法解析、19 null/停用检查、函数与秘密 scope 连续区块的字节对比、五脚本与 trusted prepare 的逐字/hash 对比。

仅抽出新模板里的 `verify_source_shape` 原函数，使用固定 fake Git 回复执行 **18 个直接边界案例，18 PASS / 0 FAIL**：正确双父与六新增、错序、旧单父、第三父、错 closed head/tree、错 APP、额外 H 文件、缺文件、修改、symlink/executable mode、rename、非零 old OID、零/非法 new OID、重复/额外 raw entry。没有调用真实 Git，没有创建 Git 对象，也没有执行 workflow、scope、provider、DB 或 cleanup 函数。

五脚本的 47/47 属于 root 已保存的 trusted prepare 实测，这里逐字保存该收据并明确标为继承证据，没有重跑或冒称本任务的新 47 tests。未安装依赖、创建云资源、使用凭据或读取生产。

首次 materializer 在任何 payload 写入前因 marker 正则未包含 `SHA256` 名称中的数字而拒绝。仅将 marker 字符集合补为 `[A-Z0-9_]` 后生成成功；原脚本和实际工具显示的错误保存在 provenance。这是本地生成错误，没有执行失败的 cleanup。

`candidate.patch` 为相对原未绑定 cleanup 的完整差分；`source-bindings.json` 固定来源与五脚本摘要；`validation/` 保存实际 stdout/stderr/命令/退出码和全部边界结果。`manifest.json` 列出所有普通文件。准备包完成后停止扩测，不形成新的发布门槛。
