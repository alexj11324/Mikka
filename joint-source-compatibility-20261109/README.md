# #1505 联合 8c 固定源码兼容性核对

## 结论

固定联合头 `8c423db291f8121980267cd48a24e428c992f618`（tree `195a66e213ca33c100e2900129079c5f83b06272`）保留了 #1805 的正式 driver、相关 adapter、official bootstrap 和 trace producer。**正式 runner 可以继续采用 `ACCEPTANCE_SOURCE=4c2efa6e9c57af88168c2d57039982ae29a9b54e`，同时将 APP/R 分别绑定未来实际发布 source。所核源码没有要求验收 checkout SHA 必须等于 App 或 runtime source。**

8c 的 canonical worker 指纹为 **`75b7462d53f9725cb92d40112c504b4f32d795c0`**，与 4c 的旧 W 不同。它是 exact 8c 的离线计算结果；未来最终合流 source 的实际 R7/public release 仍是正式 worker/source/template pins 的来源。本核对没有新增发布门槛，也没有证明未来发布、订阅、CI 或 5 秒验收已经完成。

## 固定来源与计算结果

| 角色 | Commit | Tree | 原入口实际 W |
|---|---|---|---|
| 联合候选 | `8c423db291f8121980267cd48a24e428c992f618` | `195a66e213ca33c100e2900129079c5f83b06272` | `75b7462d53f9725cb92d40112c504b4f32d795c0` |
| 验收源码 | `4c2efa6e9c57af88168c2d57039982ae29a9b54e` | `00ce4e05bb696a492183f361e4ada67eb9627e30` | `330b07a15ab6b5b0670d798736062ec1d053694e` |
| 对照 main | `e189d7652fd2fce48b77a3697abf5bb177d8ebd1` | `74b7be77de23f66162ae9558c863bb2fc9b06a56` | `425451558243799262de400b4c55eff193a349c6` |

三份 `scripts/e2b/build-template.py` 都是 blob `1db4f39b19e83d49404f1df7fd78092d3f9b7ab3`，55730 B，SHA256 `0adb53fbdd6cbcd61f1d1804aee3e2df1538997c0724556062f2741c5ac1cdb1`。daemon_start 已实际运行各自固定脚本的 `--worker-hash --source-ref <exact SHA>`，三次最终 exit 0；命令、无凭据环境键、canonical 输入、原 stdout/stderr 及初次缺对象失败均逐字保存在 `canonical-worker/`。本次收包没有重算 W 或重跑测试。

GitHub commit/compare metadata 确认 4c 是 8c 的祖先。e189 与 8c 则分歧于 `76537e4c2996f717cbd19589e1efae328028aa4a`，比较为 ahead 27 / behind 5；本报告使用 exact 两端 blob/输入，不把三点 merge-base diff 误作 e189 直接差异。该祖先状态本身没有被提升为额外 rebase/CI 门槛。

## 正式执行链保持

实际 driver 文件名是 [`scripts/acceptance/cloud-startup.mjs`](https://github.com/alexj11324/Mikka/blob/8c423db291f8121980267cd48a24e428c992f618/scripts/acceptance/cloud-startup.mjs)，没有 `cloud-startup-smoke.mjs`。

8c 与 4c 的以下范围 mode/type/blob 全相同：12 个 `packages/daemon/src/adapters/` 条目、8 个 `packages/daemon/scripts/` 条目、53 个 `scripts/e2b/` 条目。76 个 `scripts/acceptance/` 条目只有无关的 `read-cache.mjs` 变化。正式 driver、`cloud-startup-evidence.mjs`、`cloud-startup-report.mjs`、`team-workspace.mjs`、`lib/smoke-account.ts` 和 E2B runtime workflow 均同 blob。完整固定路径映射见 `scoped-blob-comparison.json` 与 `source-review.json`。

- Codex 原生 bash 仍只把 `exitCode === 0` 计作成功；apply_patch 仍只接受 `status === 'completed'`。已有 call 的晚到名称不会降级已识别 native 工具；submit-only 不算独立执行。参见 [driver L479–564](https://github.com/alexj11324/Mikka/blob/8c423db291f8121980267cd48a24e428c992f618/scripts/acceptance/cloud-startup.mjs#L479-L564)。
- MCP `status: failed` 即使 `error: null`，仍由 [Codex adapter L306–330](https://github.com/alexj11324/Mikka/blob/8c423db291f8121980267cd48a24e428c992f618/packages/daemon/src/adapters/codex.ts#L306-L330) 映射为 `tool-output-error`，不回退成成功证明。Claude adapter 没有联合差异。
- official bootstrap 与 `prepare-worker-install.py` 保持 4c 原字节，canonical build recipe 和 official conservation 三文件也保持 4c 原字节。e189 相对这些路径的差异是本方既有 worker-install、Codex failure 和官方保全修复，不是联合头撤销修复。

## 验收 checkout 与实际部署的交叉绑定

固定 [formal template](https://github.com/alexj11324/Mikka/blob/f2e59c778a6e04df30a4ad633aa7c6f7265caf86/evidence/1505-startup-timing-20261108/formal-renderer/workflow.template.yml.in) 的连接如下：

| 字段 | 实际消费位置 | 本轮可用关系 |
|---|---|---|
| `ACCEPTANCE_SOURCE_COMMIT/TREE` | L48 checkout；L207–208 exact Git source/tree；L774–775 记录 driver provenance | 固定 4c / `00ce4e05…` |
| `EXPECTED_APP_COMMIT` | L256 READY/public source；L725、733 传 `--expected-build` 和 `--revision` | 未来实际 App source，不能填成 driver SHA 代替部署事实 |
| `EXPECTED_WORKER_SOURCE` | L67 upstream source；L728、737 worker release tuple | 实际 R7 发布 source，当前计划 APP/R 同 source |
| `EXPECTED_WORKER_SHA` 与三模板 | L266、728–738、752–758 精确 release 比较 | 从对应实际 R7/public release 填入；不能沿用 4c 的 `330b07…` |

因此 formal 最终 `report.revision === expectedBuild` 比较的是 App source；它没有把 `ACCEPTANCE_SOURCE_COMMIT` 与 App source 混同。driver 自身也分开验证 `/api/version` 与 `workerSha/sourceCommit`，见 [L987–998](https://github.com/alexj11324/Mikka/blob/8c423db291f8121980267cd48a24e428c992f618/scripts/acceptance/cloud-startup.mjs#L987-L998)。

原合同保持：正常 SMOKE/shared-team、既有 Bot、普通 Task、CC/CX 各三次、`claude-haiku-5-5` / `gpt-6-luna`、runtime evidence required、official timing enabled、5000 ms 公式。formal L454–463 的必要 server stages 仍为 **8 dispatch + 17 thread + 8 claim + 6 spans = 39**；L739–771 的版本观察仍为 **首读 + 六例前后 + 末读 = 14**。这些是既有合同，没有增加 stage 或 pin。

## trace 与 Web 的实际小差异

`lib/dispatch-timing.ts`、`lib/computer/startup-tracing.ts`、`packages/daemon/src/tracing.ts` 跨三个固定 source 都是同 blob；现有 producer 没有消失。8c 新增的 `lib/tracing/sanitize.ts` 分支仅允许 `workflow.events.transport` 的 `http` / `ws` 枚举，其他值丢弃；对应测试新增。它不改变原 39 stages 或 timing 计算。[固定 sanitize 源](https://github.com/alexj11324/Mikka/blob/8c423db291f8121980267cd48a24e428c992f618/lib/tracing/sanitize.ts#L65-L78)

Web workflow 相对 4c/e189 只在冻结安装环境加 `FFMPEG_GITHUB_TOKEN: ${{ github.token }}`。该文件其余字节相同；既有 source、READY 和 `vercel pull` 捕获流程没有在该文件中改变。[固定 Web 源](https://github.com/alexj11324/Mikka/blob/8c423db291f8121980267cd48a24e428c992f618/.github/workflows/web-deploy.yml#L190-L202) 完整两项 diff 保存在 `source-differences.patch`。

## W 为什么改变

8c 相对 4c 有 6 个 raw selector 变化，5 项影响 canonical 输入：

1. `fake-claude-generation-abort.mjs` 内容 blob 相同，仅 mode `100644 → 100755`。
2. `fake-codex-generation-completion.mjs` 内容 blob 相同，仅 mode `100644 → 100755`。
3. 新增 `patches/ffmpeg-static@5.3.0.patch`。
4. `pnpm-workspace.yaml` blob 变化。
5. lock projection 的全局 `patchedDependencies` 增加 ffmpeg-static 的 hash/path 三行。

原算法将非 package/lock 条目的完整 ls-tree 行纳入，因此两个 mode-only 变化也改变 W；不能据内容 blob 不变而忽略。root `package.json` 的 raw blob 虽变，其实际 package projection 逐字相同，不影响 W。原投影保留全局 patch map，不能因 ffmpeg 不在 daemon 运行闭包而沿用旧 W。精确 diff 与全部输入绑定见 canonical 原件。

## 范围与保全

这次只读源检查及离线 canonical 计算没有读取 Actions 日志/artifact、调用模型、创建资源、发评论或触发 CI。最初本地 cat-file 探测未禁止 lazy fetch，等待后 8c/e189 commit 对象可见，可能补取了 root 对象缓存；没有执行 checkout/ref 更新。后续 Git 读取均禁 lazy fetch；缺失公开 blob 由固定 GitHub 源读取并只写入独立临时对象库。root 工作树维持 clean。

`canonical-worker/` 按 daemon_start 冻结 manifest 收入 18 个原文件及该 manifest，均保留原 bytes/hash；不复制可重建 Git 对象库或三份重复的 Git-backed source。新的顶层 manifest 记录本包全部文件。没有生成 commit/ref，等待 root 与其他未激活准备包统一归档。
