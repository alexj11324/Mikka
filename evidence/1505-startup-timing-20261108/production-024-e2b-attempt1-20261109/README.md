# A024 E2B attempt 1：下载失败与清理证据

本目录保留 2026-11-09 实际生产发布 `42566225093/1` 的原始 build/cleanup 日志和闭合回执。源码 `02401458a7fe26e00ce4caa653084c7f9680696d`；run/event/branch 为 push/main，订阅与发布均未执行。

Codex 和 Claude 安装 ffmpeg-static@5.3.0 时，同一 GitHub release asset 返回 HTTP 504。构建器删除本 attempt 的三个候选；随后外层 cleanup 在 05:23:46.5136204 UTC 独立确认全部 absent，sandboxes=[]，errors=[]。

日志按 GitHub decoded job-log 原始 UTF-8 文本保存，无重新格式化。receipt 的两个 ZIP 哈希/大小来自上传日志，本次未另外下载 ZIP；因此不声称本目录含 ZIP 原件。prospective worker SHA 尚未发布，不是正式验收 pin。

该记录是失败证据，不能计入正式六例、双订阅通过或发布成功。一次同 source 的根 test cascade 重试已于 05:35:59 UTC 发起，独立为 attempt 2，其结果不在本目录。此前历史六例 FAIL 和证据目录保持不变。
