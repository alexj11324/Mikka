# bcb CI native-tool fixture regression — 2026-11-09

本目录保留实际 CI 失败、固定 bcb 的本地 RED、首次中间 GREEN 和最终 GREEN。归档过程没有重新测试、修改产品、创建 VM、读取生产原件或移动 ref。

## 实际结果与修复

原 CI run **42637842262 / attempt 1**，head **bcb7ea695a07e479ef2c6fd52332a6f098d1f1fb**，`Integration unit checks` job **129231163760** 失败。Root 已唯一取得的完整日志逐字保留在 `ci/integration-job129231163760.log`：**670017 bytes / SHA256 969cf789cece66ab88416c6b0a14dba7324c7ee8f48e5602dd0ffc3be66e591f**。失败测试为 `scripts/acceptance/task-secrets.test.mjs:209:1`，NX task `integration-16`。原 CI 失败不会被后续本地 GREEN 覆盖。

随后 15:07:15 UTC 的 metadata 观察确认：旧 run 整体为 **completed/cancelled**，updatedAt=15:01:40；Integration job 仍为 **failure**，step 4 `Run selected integration tasks through Nx Core` 在 14:51:48 失败。Image、Desktop packaged、UI strict 被 cancelled，其余报告为 success/skipped。整 run 的 cancelled 与既存 job failure 分别记录，不能把整 run 写为仅 failure 或全部绿。该状态发生于新 head 的正常推送后，详见 `ci/followup-metadata-150715.json`。

| 阶段 | 精确来源与限制 | 结果 |
| --- | --- | --- |
| CI 原失败 | bcb，实际 GitHub runner，Node 24.22.2；完整 job 日志保留 | Integration unit checks failure；其中该四文件命令 39 PASS / 1 FAIL |
| 本地 RED | 未修改 bcb，Node 24.22.1 | 39 PASS / 1 FAIL / 0 SKIP，exit 1 |
| 首次 GREEN | 实际中间 fixture，未保存该次源码快照 | 40 PASS / 0 FAIL / 0 SKIP，exit 0 |
| 最终 GREEN | 逐字匹配 4c2 的最终 fixture，Node 24.22.1 | 40 PASS / 0 FAIL / 0 SKIP，exit 0 |

新 gate 只把 Codex `bash` 的明确 `exitCode === 0` 计作成功执行。旧测试 helper 给出的 output 是裸字符串，包含模拟 native receipt，却没有真实 adapter 会提供的 exitCode/output 对象结构。因此它在新 gate 下正确地缺少成功执行证明，生成 `startup_ended_before_execution_proof`；旧测试的成功预期失效。

修复只改 `scripts/acceptance/task-secrets.test.mjs`：成功 fixture 改为 `{ exitCode: 0, output: <原 marker/receipt 文本> }`，保留原 native receipt；既有参数化负例增加非零、null、缺失和字符串 `'0'` 退出码；最终版本把 `missingNativeProof` 设为 `{ exitCode: 0, output: 'done' }`，使该反例单独检验 receipt 缺失，不再先因退出码缺失而失败。没有放宽生产 driver 或 adapter 的成功门槛，40 个顶层测试计数也未增加。

Root 确认首次 GREEN 的中间源码与最终文件仅在 `missingNativeProof` 这一行不同，当时仍是裸字符串 `'done'`。该次源码快照未保存，本档不重构它，也不把最终源码倒称为首次 GREEN 的逐字输入；首次 GREEN 的真实 stdout/stderr/result 原件完整保留。

## 源与发布边界

最终 fixture 修复 commit **4c2efa6e9c57af88168c2d57039982ae29a9b54e**，tree **00ce4e05bb696a492183f361e4ada67eb9627e30**，sole parent bcb；GitHub commit/compare 回读确认仅 1 文件，+8/-3。最终 fixture 为 **34811 bytes / SHA256 a054629c3239e7ac3da5a31c61f34afdedd30d335375deb3de824acb5e35b93d / Git blob b0e809572a9f89f087d8bdb4b572858db8c2dcdf**。

Root 报告已于 15:01 UTC 正常 FF 发布 4c2 并读回 PR exact head，完整新 CI 已触发。因此本档不称 4c2 仍为未引用提交，也不宣称新 CI 已通过。本档自身只创建以 db35 为 parent 的未引用 evidence child；normal FF 由 root 独占执行。

15:07:15 的同次 metadata 中，新 4c2 run **42640371114 / attempt 1** 尚无 failure 观测，Integration job **129241331485** 待运行。这是瞬时 metadata，不是完整 CI 通过；未再次读取 logs/artifacts。

Root 随后把完整本地仓库规范化为 clean detached 4c2，实际 write-tree 为 00ce4e05；原始工具结果保存在 `root-verification/local-final-checkout-and-worker-hash.json`。Root 实际分别计算固定 bcb/4c2 的 candidate worker fingerprint，均为 `330b07a15ab6b5b0670d798736062ec1d053694e`。这只证明此次 test-only 追加不改变候选 worker；它不是已发布 worker 的证明，不能单凭此值填正式生产 pin。本档没有重跑这些计算。

## 实际命令

工作目录 `/workspace/scratch/263e36984c81/Mikka-1505`，三轮 result.json 的参数完全一致：

```sh
node --import tsx --test tests/acceptance.test.mjs scripts/acceptance/task-secrets.test.mjs scripts/acceptance/task-secrets-ci.test.mjs tests/task-secret-sdk.test.ts
```

完整 stdout、空 stderr 和实际 duration/exitCode 均在 `local/`，最终 fixture 与精确补丁在 `source/`。`commands.json` 分开标识三轮来源。`environment.json` 分开记录 CI Node 24.22.2 与本地主执行环境 24.22.1；测试 receipt 内的 `v24.0.0` 是 synthetic 数据，不是实际运行环境。

## 不作出的结论

这些是有限离线测试。原件里的模型、GitHub、外部 HTTP、机器和 receipt 等测试对象不能升级为生产订阅、真实 canary、Factory 验收、完整 CI 或 5 秒性能通过。原测试中确实执行的有限本地 child/fixture 行为仍按原输出保留，但不推定发生了生产资源操作。本轮没有模型请求、生产凭据读取、scope 激活或生产部署。

另附 `formal-runner-preparation.md`，仅为固定源码的只读准备结论。它记录 16 个未决字段与 root 选择的未来顺序；不是新的测试或执行回执。官方和正式 runner 源码只保留固定 SHA/URL，未复制完整源码。
