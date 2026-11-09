# Issue 1505：下一周期只读 GitHub prepare 本地预制包

## 状态与用途

本包仅供 #1805 在真实交接时审阅、绑定。没有创建 Git 对象或 ref，没有激活工作流，没有查询生产账号、领取凭据、创建 child、运行订阅或模型。它不占用共享账号，不形成 hold，也不增加 R7 的生产门槛。如果 #1810 发布 owner 负责唯一共享 carrier，本包保持停用，不能重复 prepare。

固定输入来自 [`c9b6f9531aa40dde6142291e2ce6bac476c5cea5`](https://github.com/alexj11324/Mikka/commit/c9b6f9531aa40dde6142291e2ce6bac476c5cea5) 的五个已审脚本及 prepare workflow。必须保留的关闭历史为 [`e93477fe401c70dca532784e71b76d56877b6899`](https://github.com/alexj11324/Mikka/commit/e93477fe401c70dca532784e71b76d56877b6899)。旧 C9 已关闭；本包不包含旧 receipt，也不允许重新使用旧 child。

预定唯一分支：`ops/1505-readonly-r7-20261109`。预定 GO：`root-reviewed-1505-github-r7-20261109-v1`。

## 文件与修改边界

`bundle/scripts/ops/issue1505/` 包含完整 provider、helper、store、runner 和既有测试。provider/helper/store 与固定 c9 输入逐字相同。runner 与测试各只替换一处 branch 和一处 GO 字面量；反向替换后逐字等于原件。没有更改正常 Owner getter、ambient transaction、行锁、commit 后读取、权限、空闲/占用判断、token 生命周期或 cleanup 行为。

`bundle/.github/workflows/issue1505-smoke-github-readonly.yml.in` 是未绑定模板。它同时使用 `.yml.in` 扩展名和 `if: false`；没有可识别为 GitHub workflow 的 `.yml` 文件。以下绑定在 `bindings.unfilled.json` 中全部为 `null`，模板保留相应 `__REQUIRED_*__` 字面量：

| 字段 | 实际交接时的含义 |
|---|---|
| `mainCommit` | 当时 fresh GET 确认的 main commit |
| `mainTree` | 该 exact main 的 tree |
| `orderedParents` | 精确有序数组 `[actualMain, e93477fe401c70dca532784e71b76d56877b6899]` |
| `entryDeadlineUtc` | 新 prepare 入场截止，带 UTC offset 的固定时间 |
| `hardEndUtc` | 新 prepare 操作窗口的固定硬终点；至少覆盖入场截止后的原 15 分钟 job 预算 |

未填字段在第一段 Python guard 即解析失败；不存在自动填值或自动启用器。即便有人填完字段，`if: false` 仍然保留，必须由实际执行 owner 在审阅最终具体源码后处理激活。

模板保留两条原共享队列、`cancel-in-progress: false`、`queue: max`、15 分钟 job、五项原 OIDC secret action 的完整字节、三次 current-main GET 及各自前后时间守卫、原 prepare-only 正常服务调用、精确父链和相对 main 的六路径 adds-only 限制。五个脚本的运行前 SHA256 校验保留，只有 runner/test digest 随字面量修改更新。工作流本身的字节及 Git blob 由本地 manifest 记录，未来最终绑定后须重新记录，不能沿用模板 hash。

新增窗口参数只约束 prepare 操作窗口，不是 child 四小时寿命，也不是 R7 各 job 最大 timeout 的机械总和。原三个 Python block 已 compile，未执行其网络或服务语句；没有运行 GitHub workflow、YAML action validation 或生产服务。

## 已执行的有限验证

唯一一次实际测试命令，cwd 为本包 `bundle`：

```sh
node --test scripts/ops/issue1505/github-readonly.test.mjs
```

Node `v24.22.1`；2026-11-09 15:36:38.861830–15:36:39.085956 UTC；exit 0；**47 tests，47 pass，0 fail，0 skipped，0 cancelled**。该固定 c9 源的现有测试实际为 47 项；早期历史所述 39 项不能替代本次实际计数。完整 stdout、空 stderr、退出状态、命令、环境变量名称和五文件 hash 均保存在 `tests/`。进程环境仅保留 PATH/LANG/LC_ALL/TZ（存在者），没有生产凭据；测试使用既有模拟 provider/store/runner。

第一次本地 materializer 因原 YAML 的十空格缩进与匹配字符串不一致，触发 assertion，发生在 workflow 写入和测试之前。当时仅已写入五个准备脚本。修正 materializer 的缩进匹配后完成；没有改动脚本行为、没有进行失败的生产尝试。该次错误及限制保存在 `provenance/materialization-attempt-01.*`。不要为了交付重跑 `prepare-local-package.py`；它会重写本包并重新运行既有测试。

这些结果仅证明本地预制脚本的原有模拟测试与静态绑定检查，不代表新 child、R7、正式六次订阅、生产性能或新 CI 已通过。

## 实际使用时的绑定和交接顺序

1. 先由发布 owner 确认唯一 carrier 责任人。已有 Factory/其他 consumer 完成其资源和 child 清理并明确释放后，才考虑新 prepare。若 #1810 已准备共享 carrier，停用本包。
2. 在真实交接时 fresh 检查授权账号、writer、空闲状态和正常 GitHub connection。已有不属于本方的新 child 不能被本方替换或清理。正常 connection 已可满足消费者时，不应再建重复 child。
3. 只对实际将使用的 main 做必要源码兼容检查，特别是 runner 导入的正常 DB/GitHub 服务。填入 exact main/tree、上述有序父链和新时间窗口；不能照抄 c9 的旧 main、13:40 截止或任何历史执行身份。
4. 基于 actual main 构造最终 operator tree，并将关闭的 e934 历史作为第二父。相对 actual main 必须恰好六个 operator 路径，全部新增且模式符合原 guard；不能把旧历史中的产品内容带回新 main。若 actual main 已含这些路径，现有 adds-only guard 会拒绝，需要重新审阅具体入口设计，不能直接放宽该 guard。
5. 最终完整文件必须没有未填 marker；保留原 job 条件的 repository、exact branch、attempt 1 限制，重新计算最终 workflow/commit/tree/五脚本绑定。审阅当前 main、窗口、两队列和唯一执行责任后，才由 owner 决定是否启用。本包本身不是激活授权。入场前 main 改变或时间过期，应弃用当前绑定后重新审阅，不续活旧 C9。
6. 新 prepare 成功且正常 connection 读回、独立新 receipt 保全后，关闭 prepare 入口，再推进合并触发 R7。setup 直接使用正常 DB/GitHub 服务，不依赖新 App READY；提前完成可避免 R7 subscriptions 在缺 GitHub 授权时先失败。不要在已有活跃 consumer 中轮换 child。
7. R7 两订阅实际使用该 carrier。其他正式消费者若也共享，应事先明确同一寿命与收尾责任；不能在 R7 完成时撤销仍被正式消费者使用的 child。后续正式 runner 的独立顺序仍是 R7 七 job 全成功 → fresh scope → 所选同 source Web 的实际 pull 捕获 → READY → 正式 job，不在 SMOKE 锁内等发布。
8. 根据新 receipt 的真实 expiry 和有限 release deadline 安排收尾。现有存储规则为 `min(providerExpiry, now + 4h) - 10s`；不可把各 job 最大 timeout 相加创造额外门槛。若预算不足或窗口失败，等消费者明确退出后执行该次精确 cleanup，再准备新 child；不能延长旧 receipt 或在活跃使用中换 token。

## cleanup 必须重新绑定

helper 的 cleanup 锁定精确 connection/token 身份；receipt 本身不带 current-main SHA，所以 child 可以跨主分支推进使用。实际 cleanup operator 的三次 current-main 硬守卫仍须绑定清理时的 main。跨 source 清理需要新审阅的 operator，保留本次真实 prepare run/attempt/workflow/head/branch、artifact、ZIP/receipt 字节数与 hash、精确 child 身份及新 cleanup 窗口；不能把原 prepare provenance 改写为后来的 main。

历史参考源码是 [`e5a50fa1d227eca754eb41dc0fc39a14ffd5d377` cleanup workflow](https://github.com/alexj11324/Mikka/blob/e5a50fa1d227eca754eb41dc0fc39a14ffd5d377/.github/workflows/issue1505-smoke-github-readonly.yml)，不是可以直接重开的 cleanup。它的 exact 单 receipt archive、防路径/重复成员、字节/hash、源 run 元数据及精确 revoke/disconnect 限制必须保留。按后续要求，`cleanup/` 另含一份完整但未激活的 cleanup `.yml.in` 模板、19 项未填绑定及静态说明；新 prepare 的实际 run 和 receipt 尚不存在，因此没有可执行的新 cleanup 入口。

## 原件与清单

`provenance/c9-source-input.json` 保存本次固定输入，`source-bindings.json` 保存来源 URL、commit、各文件新旧 SHA256/bytes/Git blob；两个 patch 给出全部预制差异。`static-verification.json` 记录已执行的有限静态检查。`manifest.json` 对除自身以外的交付文件逐一记录字节数、SHA256 和 Git blob，不包含生产凭据、旧 receipt 或原始生产日志。

本包在独立任务目录生成。root 的 `/workspace/scratch/263e36984c81/Mikka-1505` 只读核对仍为 `4c2efa6e9c57af88168c2d57039982ae29a9b54e` 且工作树干净；没有修改其文件或 refs。
