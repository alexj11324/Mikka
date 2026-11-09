# 下一周期 cleanup 未绑定模板

状态：**本地预制、未激活、19 项动态绑定全部为空**。模板位于 `bundle/.github/workflows/issue1505-smoke-github-readonly.yml.in`；它与父目录的 prepare 模板分开存放，实际使用时二者是同一路径的不同生命周期版本，不应同时发布。

来源为固定 [`e5a50fa1d227eca754eb41dc0fc39a14ffd5d377`](https://github.com/alexj11324/Mikka/blob/e5a50fa1d227eca754eb41dc0fc39a14ffd5d377/.github/workflows/issue1505-smoke-github-readonly.yml) workflow，原件 **26324 B / SHA256 `b73f74994833db10cac6e31e7ab109462e261398a77565d0389d32e4db6a5e9d`**。这里只复用原实现，不复用旧 prepare、artifact、receipt、child 或时间窗口。

新 workflow branch 为 `ops/1505-readonly-r7-20261109`，GO 为 `root-reviewed-1505-github-r7-20261109-v1`。五个脚本沿用父目录 prepare 包的既定字节；仅工作流中的 runner/test SHA256 随已完成的字面量改名更新，没有进一步修改 helper/provider/store/runner/test。

## 必须取得原件后填写的绑定

`bindings.unfilled.json` 的 `values` 中以下 19 项均为 `null`。模板中的每项都有同名语义的明确 marker；首段 guard 在任何网络读取、OIDC 和生产服务调用前拒绝含任一未填 marker 的状态。另有 `.yml.in` 和 job `if: false` 两层停用。填写字段不自动解除 job 停用。

| 字段 | 绑定要求 |
|---|---|
| `prepareRunId` | 本次新 prepare 的实际 run ID；不能使用旧 C9 run |
| `prepareRunAttempt` | 本次实际 attempt；本入口仅允许 1 |
| `prepareWorkflowId` | 实际 prepare workflow ID |
| `prepareHeadSha` | 新 prepare 的 exact source commit |
| `prepareBranch` | 实际 head branch，必须是 `ops/1505-readonly-r7-20261109` |
| `artifactId` | 本次 prepare 所产唯一 receipt artifact 的实际 ID |
| `artifactName` | 原 artifact 的完整名称；应匹配新 run/attempt 的上传命名 |
| `artifactBytes` | 原 ZIP 字节数，也用于下载上限和离线验证 |
| `artifactDigest` | GitHub 元数据完整 `sha256:...` digest，须与实际 ZIP 一致 |
| `zipSha256` | 实际原 ZIP 的 SHA256，须与 digest 的摘要部分一致 |
| `receiptBytes` | 原 ZIP 中唯一 `receipt.json` 的真实字节数 |
| `receiptSha256` | 原始 receipt 字节的 SHA256；直接绑定 runner cleanup 参数 |
| `cleanupClosedCommit` | **本次新 prepare 入口已关闭**的 commit；cleanup 的唯一 parent |
| `cleanupClosedTree` | 上述 closed commit 的 exact tree |
| `currentMainSha` | 清理交接时 fresh main，可与 prepare 所基于 main 不同 |
| `windowStartUtc` | 清理窗口开始时间，原 guard 要求 `Z` 后缀 |
| `entryDeadlineUtc` | 清理入场截止，原 guard 要求 `Z` 后缀 |
| `hardEndUtc` | 清理硬终点，原 guard 要求 `Z` 后缀 |
| `jobMinutes` | 明确选择的实际 job 预算；原允许范围 1–15；同值绑定 timeout 和 env |

原 e5a 的 job 是 10 分钟，本模板将该值明确留空；没有默认扩展窗口。必须满足原 `start < entry`、`entry + jobMinutes <= hardEnd`、`start <= now < entry` 条件。

两个 source run GET（run 与 exact attempt）仍须同时证明 repository/head repository、workflow path/ID、event `push`、head/branch、attempt 和 `completed/success`。artifact metadata 仍须证明 ID/name/size/digest、未过期、source run/head/branch/repository 关联。不得把 prepare provenance 替换成清理时的 main，不得把其他 owner 的 child 作为本方 cleanup 对象。

cleanup 的 sole parent 是**本次** prepare 关闭入口，不是历史 e934。e934 仅作为本次 prepare 的第二父历史；三处 current-main guard 则须新绑定清理时的 main。实际 cleanup commit 相对 closed parent 仍只允许修改该 workflow 一条路径，五个脚本字节必须保持。

## 有限差分与验证

| 项目 | 结果 / 边界 |
|---|---|
| 三次 current-main GET | 原位置与失败关闭行为保留，原 `111a...` 全改为新 marker |
| 窗口 guard | 四段原 `stamp`/`check_window` 定义及七次调用保留，包含 OIDC 前单独时间检查 |
| 并发 | `production-smoke-owner-acceptance` 与 `web-deploy-production`、两处 `cancel-in-progress: false` 和 `queue: max` 保留 |
| OIDC scopes | 五个 Infisical action 的整个连续区块与 e5a 逐字相同 |
| 下载 | `download_archive` 函数字节相同；原签名重定向限制、无转发 Authorization、精确 bytes/hash 全保留 |
| receipt | `verified_receipt` 函数字节相同；exact 单成员、路径/重复成员/类型/加密/大小/hash 校验全保留 |
| provider / CAS | 使用父目录同一组五脚本，没有改动精确 revoke、正常连接身份校验或 CAS 清理 |
| 语法 | 七段内嵌 Python 实际 compile 成功，没有执行各段；未运行 YAML action validation |
| 逆向差分 | 去掉新增未填 guard、逆转列明字面量替换后，完整字节等于固定 e5a 原件 |
| 测试与生产 | 未重跑父目录 47 套，没有追加测试、下载 artifact、读取生产、申请凭据、创建资源或 ref |

新增的首段 guard 只检查绑定完整性。填完后仍需要 owner 核对字段关系、真实来源、最终 commit/tree/hash 和当前授权窗口；本地 compile 不证明 GitHub 能执行或生产清理已经完成。

首次本地生成在最终逆向检查时发现短 run URL 是 attempt URL 的前缀，导致字符串计数 assertion 失败；发生于模板写入前。匹配范围修正为完整带引号的 URL 字面量后，逆向字节校验通过。此项仅为本地 materializer 的匹配问题，原错误与修正范围保存在 `provenance/materialization-attempt-01.*`，没有运行失败的 cleanup。

`provenance/workflow-preparation.patch` 给出全部差分；`provenance/static-verification.json` 保存原件/模板 SHA256、Git blob、逐项替换及检查结果。完整新模板 **27629 B / SHA256 `46693c759b2dd89954eb6effe0468f419938203c6b73e94a7e54d617d259071e`**。实际绑定后这些模板 hash 必须作废并重新记录最终文件绑定。
