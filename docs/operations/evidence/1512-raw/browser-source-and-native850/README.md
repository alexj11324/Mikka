# #1512：浏览器验收源码与 Native 原始账本

本目录是不可变的过程证据，**不是生产验收通过记录**。

## 当前源码

PR #1665 的候选 `58089592b806caba919fd0f5184ea3f8499419fa` 仅修改 9 个文件。Live 的修正已有原代码失败、新代码 59/59 的证据（见上一份归档）；本目录保存浏览器 helper/actor 的完整源码、固定依赖、原始输出和评审。原 driver + helper 39/39；actor 30/30，包含实际模块组合，但 Chromium、child 与 API 回复由离线替身提供。没有进行真实登录、数据库或模型调用。

新 actor 的两个红灯使用早期 actor 草稿；这个文件在 0d379 原产品里不存在。不要把这两个红灯描述成原产品已经存在的浏览器实现。原草稿、原 TAP、修改差分和最终输出均保留。

PR 已从合并完成的批次正常改 base 到 main，head 未变。早先创建的 CI 实际使用 retarget 前的合成提交 `c3b6b1525a36f5567a38d1720f03b588988c4036`（父提交 850622 + 580895）；merged main 4672 与 850622 的 tree 相同，但不把旧合成提交的父提交改写为 main。初始快照的源码 lint 失败随后被精确定位为一次多余的 iterable 数组展开。最新候选 `a9072e5835a1f7e14aae0af0033d1b682433651f` 仅删除 5 个字符；见 `ci-580/root-lint-correction.json`。`source/` 保留初始候选，`lint-correction/` 保存更新后的 actor。旧 CI 的原始失败和 glob 匹配字段更正分别保留；整轮最新 CI 与 Native 验收仍待完成。

## Native 原始报告

- `evidence/desktop-850622/index.json`：完整的既有安装包验收。实际 checkout f23dcd19，harness adc8ec…。功能检查通过，但登录 **Native 211 / Chromium Web 210**、启动 **bundled Native 177 / hosted Electron 118**，两项查询预算均失败。
- `evidence/desktop-850622/integration-difference.json`：17 个 operation、75 个 unattributed source、逻辑和物理 RPC 的独立账本。hosted 启动有 3 个跨结束边界的请求，不据此补算或调整窗口。Native 多出的读取目前只属于观测事实。
- `root-native850-recomputation.json`：root 直接从原 lifecycle.json 重新核算 12 个快照、8 个分段、4 个总窗口；分区与差分全部守恒。算术有效不等于预算通过。
- `evidence/desktop-0d379-partial/index.json`：上一版 Native 在 parity 中途被取消。只有 4 份原件，没有 lifecycle.json；登录/启动预算、后续 parity/lifecycle 清理保持 unknown。较早 smoke 的清理成功只适用于 smoke。

这些报告都发生在 PR #1665 的 Live 修正之前，不能外推为修正后的表现。

另有 `evidence/desktop-580895-pre-native-terminal.json`：初始候选 580 的 workflow 被正常后续分支更新取代，取消前仍在编译，真实 Native step 16 为 skipped。它没有 Native 预算报告，不能与 0d 的已进入后取消混为一谈。

## 边界与资源

helper 与 actor 共用的一台 1 CPU / 2 GiB、deny-all Linux Sandbox 已主动停止并独立读回 stopped。0d partial 和 850 原件恢复分别使用最小临时 Sandbox，也都已停止。恢复仅保留允许的 JSON 和校验结果；不保存 ZIP、图片、下载签名 URL、生产日志、会话或凭证。

原始输出保留原字节，所有载荷都有字节数、SHA256、Git blob ID 和 root 远端读回校验。原证据中“未关联 blob”的状态是生成当时的事实；本归档随后把这些对象纳入 evidence 分支。

#1512 的生产同 trace、全部生成、Logs、Replay、截图、最终 Native 查询预算与清理仍未通过，issue 保持开放。
