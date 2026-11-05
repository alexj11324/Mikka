# A：首个 TS consumer 有界授权候选与实际证据

Refs: alexj11324/Mikka issue 1212.

**本轮完成可复核的窄基础，尚未接入生产，也没有获得 egress 下降结论。** 建议先作为代码/证据检查点保留；生产 source、依赖版本覆盖和现主线集成完成前，不应把它合并为已完成的轮询优化。

## 冻结身份

- 基线 commit：`a410b292cc53cfef43992a91d7696023e3481567`。
- 实际 Vercel worktree `git write-tree`：`202fe0baf19f3a45f110b16e705085cd364d2726`。这是 tree，尚未创建 commit 或 PR。
- 共 8 个文件：4 个产品文件、4 个测试/fixture 文件。`candidate-manifest.json` 给出逐文件 Git blob、字节数及 SHA-256；`candidate-filemap.json` 是完整内容。共享拷贝已逐一验证 Git blob 和 SHA-256。
- 产品窄 diff：`product.patch`；全部 diff：`candidate.patch`。
- 最终 HTTP fixture SHA-256：`363a8fa8015efd467c601b8b0bc57af0e1ce3f19b837714d72a830b0ef28c645`。
- 原始包：`final-packet-manifest.json` 记录 71 个导出文件及校验值；归档 SHA-256 为 `b1c66920c3f1ba10f9356837f6e11e1183424ae020d7250717351e55c09fc4ce`。
- 当前主线已前进到 parent 报告的 `a18d22a9d4b6b067297a72eb37205493be4f0b2b`。本候选没有追合主线，不能声称覆盖该主线全部权限写入口。

## 四个产品文件

`packages/daemon/src/agents/run-authority.ts` 增加本地单调时钟授权租期。首次 challenge 和每次续期都从**发送时刻**计时；本地上限 750 ms，给现有子进程取消路径留下时间。等待新响应不会延长旧租期。nonce/runId 不匹配、拒绝、非法时长、源错误、超时均失效；迟到响应不能恢复已撤销的 gate。

`packages/daemon/src/agents/tool-approval.ts` 仅在显式提供 source 时替代后台 host 授权检查。真正操作仍调用原来的 fresh `host.isLive`。没有 source 的客户端继续原有每秒检查、慢冷启动行为和已有取消路径；额外 credential monitor 仍保留。

`packages/daemon/src/server-link-http.ts` 保留原第 4 个 `worktree?: string` 参数，新 source 位于第 5 个可选参数。原生产调用者不会意外启用它。没有增加环境开关、公开端点或生产 transport；目前只有隔离 fixture 显式提供 source。

`lib/run-authority/source.ts` 在 App/Workspace 持久版本读取之前、之后夹住完整权限 reader；任一库版本变化会重读，反复变化则拒绝。source generation 也参与比较。该候选**没有成功结果缓存**，每个 challenge 都完整读取；不会把通知送达或连接健康当成数据库权限仍有效。

## 严格相同 fixture 的 RED → GREEN

先保留最终 fixture 及 helper，再仅恢复旧基线的 `tool-approval.ts` / `server-link-http.ts` 跑 RED；之后逐字恢复候选这两个产品文件，重新跑完整原 store/HTTP 套件。fixture 的 SHA-256 在两次运行之间未变，结果见 `evidence/mikka-authority-strict-final-results.json`。

| 场景 | 真实结果 | 原始日志 |
|---|---|---|
| 旧产品，真实 Stop 提交后 HTTP 响应被挂住 | 1002.706 ms 观察时 gate 未撤销、child 未退出；断言 FAIL | `evidence/mikka-authority-http-red-strict-final-2.log` |
| 候选，同样 HTTP 交付阻断 | gate 518.712 ms 撤销，child 525.117 ms 退出；SIGTERM 标记 143 | `evidence/mikka-authority-http-green-strict-final-2.log` |
| 候选，Stop 提交后实际 PostgreSQL barrier SELECT 被锁阻塞 | `pg_stat_activity` 确认真实锁等待；gate 652.677 ms 撤销，child 656.031 ms 退出；SIGTERM 标记 143 | 同上 |

两条 GREEN 均使用真实 device-authenticated HTTP claim、真实签名策略、实际 PostgreSQL 权限 reader、`HttpServerLink`/`ToolApprovalGate` 和 `ClaudeAdapter` 子进程。模型端仅使用仓库现有离线 fake CLI，没有模型调用。Stop 由真实 `stopOwnedRun` 提交，另一个 pool query 确认提交可见。

最终断言同时要求：Stop 前 child 尚在运行、实际 `exitedAt` 时间差不超过 1000 ms、从 Stop 调用前开始计时的保守时间差也不超过 1000 ms、gate 已撤销、SIGTERM 标记为 143、Stop 后仅有 `exit` 事件。`until()` 只负责等待，不负责决定是否达到时间门槛。

**证据组合的边界：** HTTP child fixture 的真实 route 仍使用 combined App/Workspace 布局；另一个物理 Workspace DB 参与版本向量。真实 split App/Workspace 的 policy membership 竞态由下面独立 6 例证明。这两组不应被写成一条同时覆盖 split membership 的 child 端到端轨迹。

实际 child 是会响应 SIGTERM 的仓库 fake CLI；该证据没有证明任意不响应 SIGTERM 的进程或真实付费 CLI 都在同样时间内退出。

## 其它已通过门禁

| 门禁 | 结果 | 原始日志 |
|---|---|---|
| 原 AgentToolApprovalStore PG 套件 | 12/12，无 skip | `evidence/mikka-authority-http-green-strict-final-2.log` |
| 完整 HTTP 套件，含两条 child 故障 | 5/5，无 skip | 同上 |
| 两个独立物理库的完整 policy/membership reader | 6/6，无 skip | `evidence/mikka-authority-version-db-final-2.log` |
| consumer 单元 + 既有 gate/Claude/liveness 兼容 | 28/28 | `evidence/mikka-authority-consumer-review-final.log` |
| App 正式 `pnpm typecheck` | exit 0 | `evidence/mikka-authority-app-types-review-final.log` |
| daemon 正式 `pnpm --filter @mikka/daemon typecheck`（tsgo） | exit 0 | `evidence/mikka-authority-daemon-official-types-final.log` |
| 产品 4 文件 oxlint、最终 HTTP fixture lint | exit 0 | `evidence/mikka-authority-lint-review-final.log`、`evidence/mikka-authority-final-fixture-lint.log` |

split PG 六例覆盖：完整 reader 的稳定双库快照；App Stop 在完整读取后提交；Workspace membership 在完整读取后撤销；业务写与版本一起 rollback；真实 FK parent 删除；两库均变化后又回到原值仍强制重读，不能产生 ABA 误判。没有 mock 权限 reader 或 membership guard。

consumer 回归覆盖首次 source 静默、发送/接收时刻差异、迟到成功不复活、nonce 重放、错误 runId、拒绝/非法时长、无写入的自然到期、source 错误及恢复不续旧权、逐操作 fresh 与旧客户端后台检查。

隔离版本 trigger 只存在于 `tests/helpers/run-authority-version-fixture.ts`：对 fixture 的全部 public tables 提供同事务版本变化，确保这些实验不会因漏一个测试关系而接受旧快照。它没有进入 migration，也不是生产依赖清单、并发性能或写入覆盖证明。

## 查询成本和 Go 基线

稳定完整 snapshot 实测：1 次完整 reader，另有 App 2 次和 Workspace 2 次版本 SQL。当前 source 每次 challenge 都如此读取；客户端在响应后 200 ms 发下次 challenge。没有 shared source/cached reader 的成本改善证明，不能称健康路径 0 DB、不能称已降低 egress。

旧 Go 路径单独测得：Claude native 997.248 ms、Codex native 998.250 ms、Claude CPA stream 997.758 ms 取消 silent provider context，均未输出 chunk。代码与原始日志在 `go-baseline/authority_idle_test.go`、`evidence/mikka-authority-idle-go-1.log`。这三条仍使用原一秒轮询，没有切换 source；作为基线证据保留，未加入本次 8 文件产品树或新 CI 门禁。它们不是 API key/真实三路径生产验收。

共享目录中早期未格式化 Go 拷贝另存于 `historical-layout/authority_idle_test.unformatted.go`，只保留历史；它不在最终 71 文件归档或 8 文件候选清单。共享目录同步曾在删除后重新带回旧副本，因此发布与复现必须按 `candidate-filemap.json` / `candidate-manifest.json` 的 8 文件白名单，不能整体复制共享 `candidate/` 目录。GitHub 证据包也严格按白名单生成。

## 保留的失败与修正

原始 setup、类型及 fixture 失败均保留。包括临时签名环境缺失、fake CLI 相对模块缺失、对 `stopOwnedRun` 返回值的错误 fixture 假设、FK 实际为 cascade 的预期修正、合并双场景后触发同 owner agent 名称唯一约束。第一条有效 RED 是 `red-cli/red-4.log`；最终同 fixture 对比以本页严格版日志为准。

产品代码曾错误占用原 worktree 第 4 参数，被 daemon 类型检查发现并修正为第 5 参数。新 `.ts` fixture 曾把 Next 的 `ProcessEnv` augmentation 引入 daemon adapter；最终把实际 adapter 场景放回已有 Node HTTP `.mts` 边界，没有改 tsconfig 或运行器环境。额外用 tsrs 检查 daemon 时产生的旧 polling test 推断错误也保留；正式 daemon gate 使用仓库配置的 tsgo，并已通过。

## 上线前仍缺什么

1. 与当前 main 的真实授权 predicate、所有写入口/FK/撤销路径逐一集成，生产同事务版本触发器覆盖及并发影响证明。不能使用 fixture 全表 trigger 代替。
2. 既有 DeviceSession 内经过认证的共享 source 和两库连接身份/连续性证明；真正协议能力协商、故障重连后的全量快照。没有创建新 Cloudflare 资源或配送生产数据库凭证。
3. 在覆盖证明成立后再做缓存/共享 barrier，实测 SQL 与 egress；目前完整 reader 频率更高，所以 source 不应直接开启。
4. pause/resume、人工 controlUntil 到期恢复、`device_lost` 原因保留、完整生产 expiry reader，以及原 PostHog/route/quota 语义。不能把目前仅停止/失效的基础当作全部状态协议。
5. Go native broker、CPA/API 路径和其它 consumer 的实际迁移；逐操作/逐 chunk 的 fresh gate 继续保留。
6. CI/inventory 接线、当前 main 集成、真实生产验收与整体观测。当前未开 PR、未部署，也未发任何生产模型请求。

## 收尾

`owned-process-check.json` 在 `2026-11-05T00:30:28.934792+00:00` 确认本工作目录下剩余运行进程为 0。没有停止共享 PostgreSQL 或 sandbox；parent 可在其它任务完成并拿到导出包后统一清理。生产模型调用、生产账号偏好变更、生产 DDL/DML及新增 Cloudflare 资源均为 0。

随后按原始测试日志、固定实验目标和 fixture 创建路径逐一核对本任务数据库。`cleanup/mikka-authority-cleanup-receipt.json` 在 `2026-11-05T00:39:45.946Z` 记录 30 个隔离数据库普通 `DROP DATABASE` 成功；执行前这些库没有活跃连接，未用 `FORCE`，提交后复查 `remainingOwnedDatabases=[]`。本任务没有创建专用 role；现有 `postgres`、共享 `mikka_test` 和另一代理的列表集成 role 全部保留。

一个未找到创建记录的空库 `approval_e2e_202611042353000000000001` 仅只读确认无用户表并保留，不将它冒称已归属或已清理。共享服务与其他任务的数据库均未停止或删除；parent 已明确在其他工作结束后统一回收共享 sandbox。
