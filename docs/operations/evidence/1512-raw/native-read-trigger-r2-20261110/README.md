# CP52：R2 Native 读取触发诊断、原件和资源收口

## 结论

R2 的 GitHub job 功能步骤终态为 success；**本轮完整登录预算仍失败：Native 431 > Web 427（+4）**。FIRST 配对 1 为 **bundled 201 ≤ hosted 225**。这是临时诊断源的实际结果，不能代替正式源码 d2c 的结果，也不是最终生产验收。

正式 d2c 完整登录仍为 **424 > 358（+66，FAIL）**，FIRST 为 211 ≤ 221；#1512 正式生产用例仍为 **0 / 2**。本包不表示可以合并或关闭 issue。

## 固定身份与时间

| 项目 | 固定值 |
|---|---|
| R2 run / attempt / job | 42721481301 / 1 / 129516256901 |
| 临时应用诊断源 S | `668f1a3543f8d007d0b1cae655a2595c1cfa657f` |
| S tree | `5a72ec243b49bf7c0547f97d2b636938afe1ee3a` |
| R2 execution head | `33e9aea47726d3d83534d57345eab1f78181e0b6` |
| R2 execution tree | `a39f0e61c58c9319aff548a232152579322d3f8f` |
| 正式基线 d2c | `d2c3f63448130443e3e10bb5304417162f585776` |
| 正式基线 tree | `a311b73945e9846a33a2bbd3ffa54b9e23888b1d` |
| R2 job | 2026-11-09 23:34:04–23:53:29 UTC；completed / success |
| 实际 Native acceptance step 19 | 2026-11-09 23:44:34–23:53:09 UTC；success |
| 本包父归档 | CP51 `e7d42533c70fab962df2dbaa0e09f0cab75df9a4` |

[实际 R2 run](https://github.com/alexj11324/Mikka/actions/runs/42721481301)。原件中的源码清单、8 项临时 overlay、workflow、manifest 和运行身份逐项一致。R2 的内存配置是独立执行源，不改写 CP51 首轮 OOM 的历史。

## 四个原始计数窗口

| 窗口 | query calls | RPC physical started/completed | RPC logical started/completed |
|---|---:|---:|---:|
| Web 完整登录 | 427 | 35 / 35 | 35 / 35 |
| Native 完整登录 | 431 | 15 / 15 | 40 / 40 |
| FIRST bundled startup | 201 | 7 / 7 | 19 / 19 |
| FIRST hosted startup | 225 | 19 / 19 | 19 / 19 |

这四窗的 RPC crossesStart、crossesEnd、completionNotObserved、completionWithoutStart 均为 0。完整登录分段保持原值：Web 19 + 0 + 408，Native 19 + 15 + 397。原始 24 条记录、12 个 checkpoint、8 个分段、17 operation 与 78 source 分桶、1284 条 ordinal 记录及未知值全部保留；既有验证记录为 0 算术错误。未改窗口，未扣背景工作，未把 RPC 调用数兑换成 SQL 数。

## 诊断的实际限制

Sidecar 是 **incomplete**：524288 字节上限；droppedRows 28、invalidPackets 1、unsealedDocuments 4、lateDocuments 1、schemaOther 213。原件保留 attachmentLate、未封口和其他未知字段。

最后一个 Native 文档保留到 sequence 294，而元数据到 320；**缺失 sequence 295–320 的 26 条记录可能仍在原始窗口内**。最后保留事件距原窗结束还有 324 ms。保留行内部的 sequenceGaps=0 不证明尾部完整，不能将缺失记录判作窗外或不存在。

原 parser 的输出完整原字节保存在 `analysis/read-diagnostic-parser.output.json`。其 singleton 外层 dispatch 与 item 子记录可能双计的展示问题，由 `analysis/causal-read-trigger.safe.json` 单独明确校正：有 item 子记录时选择子记录，否则选择外层 action。它没有改写旧输出或服务器计数。Native 原服务器 logical 40、校正后 product 39，余下 queryless session 1 仍为未知关联；没有共享 ID 的产品/CDP/SQL匹配保留候选与歧义。

R2 实际安装的 daemon 为 **0.0.566 / 2ff5c07fa1358fb0218aad578ab1032ad3ad351c / protocol 3**；旧 d2c 为 0.0.564。跨轮差额不能全部归因于诊断 overlay，也不能排除诊断 CPU/IPC 开销。没有重跑同一 Native 来挑选更有利样本。

## 原件与派生证据

- `originals/native/`：8 份完整 JSON，保留 artifact 内相对目录。
- `originals/package/`：2 份完整 JSON。
- `originals/job-129516256901.original.log` 与 `.wrapper.json`：唯一 reader 已冻结的原日志及工具包装；本次只从 Git 复用。plain 与 wrapper 的正文完全相等。
- `originals/artifact-members.321.safe.json`：两个原 ZIP 的 321 个成员元数据。10 份选定 JSON 的路径、字节数、SHA256 和 Git blob 全部逐项相符。ZIP 与未选图片不在本包；未声称阅读 PNG 像素。
- `runner/`：精确 workflow、manifest、准备/发布和 23:41、23:52 中间快照、最终总索引。中间快照的 pending 状态按原件保留，由最终证据说明后续结果。
- `proofs/`：算术和源码、资源与关闭入口、归档输入完整性。
- `analysis/`：固定 parser、原始输出、Live 逐 key 表和最终有限因果分析。
- `public/`：#1512 两条指定进度评论原 body 与读取回执；不发布新评论。

原 Actions 日志及两个 ZIP 均由 native_diag_runner 唯一读取，本归档者新增原 Actions / ZIP 读取次数为 0。所有保存对象都按原字节、SHA256 和 Git blob 校验；原件不脱敏改写、不重新序列化。安全扫描只覆盖明确凭据/签名模式，不能声称是全面语义隐私证明。

## 真实清理与入口关闭

PG 实际启动过，随后真实执行 cleanup：stop exit 0，ready exit 2，pg_ctl status exit 3；23:53:10.517–23:53:16.470 UTC 回执为 `owned_postgres_stopped`。

应用 cleanup 各阶段 passed，lease 观察为 released，owner/peer 的 after sealed baseline 为 true；原 before=false 等差异原样保留。Lifecycle workspace `phase=unchanged, restored=false`；parity 为 `phase=restored, restored=true`，不能将两者统写成恢复成功。

提取 VM `sbx_9K0VEdh0ADfw3kjdmf0f24xREC3F` 于 **2026-11-10 00:04:11.008 UTC** 停止；删除成功并经 exact GET 404 确认，当前 owned VM 为 0。没有为 CP52 新开资源。

诊断入口 `ops/1512-native-read-diagnostic-memory-20261109` 已正常 CAS 至关闭 head `9a48da1e514fc6f805078607b43630e2d779aba0`，manifest enabled=false。关闭 run 42725531132 / job 129530076910 真实 skipped，无 runner、steps=[]；不是另一次 Native attempt。

## Canonical 输出的适用范围

`canonical/canonical-generator-execution.safe.json` 记录同一个既有提取 VM 中的真实 Node v24.22.1 / TypeScript 5.9.3 generator 执行，以及两个完整生成输出 `apps/api/generated/routes.json` 和 `routes.ts`。这些是**未来联合源码准备**，不是 R2 实际应用源码、R2 原 artifact 或最终生产 PASS。

后继联合源关联回执固定未发布 commit `565429bc8749e1007b5ec30c2b4a4b92f43fa5ed` / tree `845fb6f21f3ec78c94f60888c11e38573e38e3ea` 的当时状态：published=false、CIStarted=false、productionCases=0。仅保存该关联，未把 R2 测量迁移给它。

## 归档完整性

`index.json` 列出每个 payload 的相对路径、mode、Git blob、字节数和 SHA256；index 自身不递归列入自身哈希。共 36 文件（35 payload + index）。唯一重复内容是 execution manifest 同时保留在原 artifact 路径和 runner 角色路径。

只在 CP52 前缀新增叶子；CP51 的 8801 个旧 blob 叶子应逐路径、模式、对象完全保全。最终 Git tree 与正常 CAS/readback 由归档者独立核验。本次没有 source/main/ops ref 修改、评论、测试、CI、模型、账号或生产操作。
