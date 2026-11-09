# 激活绑定表（当前全部未填）

| 输入 | 当前值 | 激活时唯一来源/用途 |
| --- | --- | --- |
| baseCommit / currentMainCommit | null / null | 同一次 fresh actual main GET；两者必须同值；operator唯一parent |
| baseTree / currentMainTree | null / null | 对上述immutable commit的tree独立核对；两者必须同值 |
| freshScopeReceiptSha256 | null | root已核并持久保存的本轮真实scope创建回执全文SHA256 |
| diagnosticEnvId | null | 同一fresh回执中的实际平台env ID，不能使用历史YOG…等旧值 |
| diagnosticValueSha256 | null | 同一fresh回执对应完整scope JSON的SHA256；不把scope正文或token放入workflow |
| diagnosticExpiresAt | null | 同一fresh回执的实际UTC expiry；删除不撤回既有DPL值 |
| startAt | null | 本轮已确认协调窗口允许入场起点 |
| latestEntryAt | null | 本轮最晚入场时点，latestEntry+10min≤hardEnd |
| hardEndAt | null | 原协调硬截止；排队/OIDC不延长 |
| rootReviewGo | null | root审完精确enable diff后填固定 root-reviewed-1505-diagnostic-cleanup-r7-20261109-v1 |
| operator SHA/tree | 尚未存在 | 创建正常单父两路径commit后的Git回读；运行时HEAD必须等于GITHUB_SHA |
| branch | ops/1505-diagnostic-cleanup-r7-20261109 | 固定；未创建ref |
| helper bytes | 固定5958原件 | SHA46d8…898c/blob e9f07…1d9；不可修改 |
| exported SOURCE/TREE | 原e33/b2e常量 | 仅旧removeOwnedWindow输入schema，不是fresh创建证明 |

最终仓库仅增加 `.github/workflows/issue1505-diagnostic-cleanup-r7.yml` 和 `scripts/ops/issue1505-diagnostic-cleanup-r7.mjs`；本表、manifest、builder、syntax提取件与本地bindings均不加入该两路径操作提交。
