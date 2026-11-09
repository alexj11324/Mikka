# main7848：订阅门槛失败与资源清理证据

本目录仅对应 source `7848e79df9c5af67e526aeed1c828858db392066`、worker `aa7efbbe2969d8b1578bdba093e6400a26749e07`、R7 `42690423873 / attempt 1`。后续 main/source/run 的结果不属于本证据集。

实际终态为：`test`、`check`、`validate / build`、`await-web` 成功；`subscriptions` 失败；`publish` 跳过；`cleanup` 成功。详见从 exact-attempt REST 元数据生成的 `terminal-metadata.json`。

## 订阅结果

- Claude Code 的完整订阅门槛通过。原件含真实共享订阅、官方 CLI 摘要、成功工具调用、工具之后的回复、真实 agent ACK、bootstrap adoption 和 cleanup 证明。
- Codex 的工具调用、工具后回复、预期 agent ACK、runtime evidence 均通过，但 `preparationTiming` 不可用，缺少 bootstrap adoption 证明。原始失败码为 `template_gate_bootstrap_adoption_missing`，整个订阅门槛保持失败。
- 本轮没有公开发布模板，没有新的正式六任务性能样本，也没有宣称达到 5 秒目标。以上订阅候选验证不能替代正式普通 Task 启动验收。

## 清理与原件

`release-cleanup.json` 记录本轮 desktop、claude、codex 三个私有模板均为 `deleted`，`errors` 为空，匹配本 release 的 sandbox 列表为空。`build-cleanup.json` 记录构建阶段清理无错误。这不是其他 owner 资源的全局清理声明。

三个 ZIP 均保存为明确命名的 `*-original.zip.base64.txt`。严格解码可恢复原 ZIP；CRC、唯一 member inventory 和 member 对应 JSON 的原字节相等已核验。JSON 与 Actions 已遮掩日志均从 root 的本地缓存逐字复制，没有重新下载原件。

日志模式检查出现的两条 `e2b_` 前缀匹配已独立定性为公开依赖 `e2b_dockerfile_utils` 的 wheel 文件名。其他检查及 GitHub 原遮掩保持；详见 `log-publication-review.json`。

本次归档仅创建未挂 ref 的单父证据对象；没有更新 ref、运行模型、创建云资源或读取生产秘密。
