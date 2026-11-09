# #1505：正式发布前复核记录（2026-11-09）

本记录供执行 #1505 的 owner 绑定下一轮生产发布与六个普通 Tasks。它记录已核源码和执行顺序；正式新样本仍为 0，没有新建 child、诊断 scope、模型消费者或 VM。

## 已通过的源码与 CI

PR #1805 的固定 head 为 `4c2efa6e9c57af88168c2d57039982ae29a9b54e`，tree 为 `00ce4e05bb696a492183f361e4ada67eb9627e30`。Root 于 15:35 UTC 直接读取该 head 的全部 9 个 workflow 和 42 个 check：9 个 workflow 成功，35 个 check 成功、7 个按原规则跳过，无失败或在途项。主 CI `42640371114/1` 已于 15:29 闭合；Mac packaged acceptance 于 15:28:54 成功。该证据是 GitHub 对 PR head 的关联，不额外声称已从 runner 日志独立核验 checkout。

上一 head `bcb7ea69…` 的实际 Integration 失败仍保存在 [29218a0f 固定证据](https://github.com/alexj11324/Mikka/tree/29218a0ff3f8dd458963eed3956666572b564309/ci-bcb-regression-20261109)。修复只纠正 Codex bash fixture 的原生 `{exitCode, output}` 形状，未放宽成功工具门槛。

#1810 已正常采用双方联合源 `8c423db291f8121980267cd48a24e428c992f618`，tree `195a66e213ca33c100e2900129079c5f83b06272`。Root 直接核对其 sole parent 为 `84e15fe935243ea6cf1399b4b50a436accdd5251`；84e 的有序父提交为 5c705 与 4c2。8c 相对 84e 只校正原 ADR 两句 Desktop fresh symlink target 描述。联合源自己的 CI `42649186661/1` 在本记录时仍运行；4c、5c 的成功不能代替联合源成功。该发布及 R7 由 #1810 owner 唯一负责；#1505 六例仍由本 owner 独立负责。

## 必须在真实发布中保留的文件

| 文件 | 已核 Git blob | 用途 |
|---|---|---|
| `scripts/acceptance/cloud-startup.mjs` | `6753c8aa8adf4354b60be3d62dcc5d5458f36cd9` | a709 的独立成功工具及后续回复门槛 |
| `packages/daemon/src/adapters/codex.ts` | `e85815a955eaff56d7ac389c9d9722c64607345d` | f044 的 MCP failed/result-present/error-null 映射 |
| `scripts/acceptance/task-secrets.test.mjs` | `b0e809572a9f89f087d8bdb4b572858db8c2dcdf` | 4c 的真实 Codex fixture 与负例 |

正式 R 必须包含这组修复，并用同一 run/attempt 的 accepted 与 public release 证据绑定 source、worker fingerprint 和三模板 ID。测试 fixture 不在 worker fingerprint 范围内，不能据 W 推断其存在。候选 W `330b07a15ab6b5b0670d798736062ec1d053694e` 没有被当作已发布 W。

## 执行顺序

1. 在实际交接时确认唯一发布 owner、main、消费者和正常 GitHub connection；确实需要且空闲时才准备新 readonly child。使用新 receipt，关闭 prepare 入口，再正常合并触发 R7。旧 C9 已撤销，不复活。
2. 确认 R7 同一 run/attempt 的 `test`、`check`、`validate / build`、`await-web`、`subscriptions`、`publish / deploy`、`cleanup` 七项均真实成功。PR 路径跳过、未发布候选或不同 attempt 不能替代。
3. 在 R7 的第一次 Web 已 READY/public 后创建 fresh timing scope，保留精确创建及读回原件。准备独立、未激活的 exact-cleanup operator。
4. 发起第二次同源 Web 构建，使其真正执行 `vercel pull` 并捕获 fresh scope，再核 build/upload/READY/public。现有手动入口需要 `overlay-refresh=true`；旧 READY 或 workflow success 不证明捕获了后来创建的值。
5. 填齐 formal renderer 的 16 项动态绑定，确认 scope 入口剩余至少 45 分钟，才激活正式 job。正式 job 从开始持 Web 锁，不能提前进入该锁内等待 R7 publish。
6. 运行 CC/CX 交替的六个普通 Tasks，逐例检查完整证据与清理。按原规则记录失败，精确删除本轮 scope，关闭入口；child 的原件、实际 TTL 和最终清理责任在交接时明确。

本轮计划 APP source 与 R 一致；两者在绑定表中仍是不同字段。若交接前 main/App 改变，重新核实际 APP 与 runtime 组合，不能用旧 R 冒填 APP。

## 测量合同

模型保持 Claude Code 的 `claude-haiku-5-5` 与 Codex 的 `gpt-6-luna`，使用原 SMOKE 身份和 Bot `fdeea45f-8cb2-450a-96a4-d9a682f71482`。每条路径三次，使用普通 Coordinator→Task→cloud 流程。

每例的原始毫秒公式保持为：

```text
Date.parse(agentStart.storedAt) - Date.parse(timing.dispatchStartedAt)
  + Math.max(0, runtime.agentAccepted.ms - runtime.executionStartMs)
```

每例必须 ≤5000，且出现独立成功工具之后的正确回复。submit-only 不算独立执行。服务端 39 分段为 8 dispatch、17 thread、8 claim、6 spans；daemon 初始化另外校验。运行期版本检查共 14 次：初始 1、六例前后 12、最终 1。这里的 14 次检查与 renderer 的 16 项绑定不是同一数量。

## 提前失败的精确清理

原正式模板的 cleanup 条件还要求 `source_ready` 和 `platform_token` 成功；checkout、上游或 token 步骤失败时，即使有 `always()` 也可能跳过清理。独立 cleanup 包覆盖这一已证路径。

固定 helper `5958dea38437de20512bbbdf60b940ccc83f00ff` 的 `removeOwnedWindow()` 完整原文件为 27063 B，SHA256 `46d8b905518cf480fecdf0a3bce1a3863f4e79c92609b1cd3ec9d4231820898c`。Pure caller 只传 fresh ID、value hash 和原 expiry；旧 SOURCE/TREE 仅是导出函数 schema 绑定，不是新创建回执。恢复 operator 只读取原 Actions OIDC `/platform/VERCEL_TEAM_TOKEN`，核精确值后 DELETE 指定 ID，最终确认 ID 404 与同 key 缺席。目标变化时拒删，响应不明时保留 unknown，不盲重试。

## 下一轮分段的定位重点

现有历史报告不足以证明当前代码必然超时；也不能由安装期缩短推算 dispatch 收益。下一轮优先核对 provider create→bootstrap/注册、共享订阅 fresh claim/配额、实际 native ACK 尾段。旧 d75 六例为 20,150–26,369.789 ms；78c 的另一批约为 14,409–18,846 ms，并含执行证明失败和 13/14 版本 pin，不能表述成六例都执行成功或作为新源成绩。所有原失败保留。

## 本次有限检查

只读源码复核没有运行新的模型或生产探针。Root 在 exact 4c、Node 24.22.1 中实际导入 `cloud-startup.mjs`，确认四个 scope 准备所需 export 均为函数，exit 0、业务函数调用数 0；因此此固定 import 闭包不需要新增依赖安装。Readonly 准备包的原模拟测试单次 47/47 通过，其 32 个文件已独立核 hash/blob/bytes 并归档。上述检查不替代 R7、scope 实际创建或正式六例。
