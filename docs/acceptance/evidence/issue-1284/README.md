# #1284 component visual review

These screenshots render the actual Agent Profile settings, editor and task selector in a Docker Cloud Sandbox production build with synthetic fixture data. They are component layout evidence only: no real account, credential, model call or final deployment acceptance is claimed. The fixture is outside the product repository and has no authentication or mutation API.

Captured 2026-11-05 UTC from the pre-rebase implementation working tree based on 2b25caad1608df6a2a54d5e18e798b3c9807ce89. Product UI source was later replayed onto fc2d401bde7b3f567b1288b01accd6fdeb433d0c. The PR records exact-head CI, isolated authenticated API acceptance and subsequent production acceptance separately.

Reviewed: desktop editor and dark list; 390px list/editor; default/empty and loading-error recovery; unavailable choices in the task picker. The 390px iframe has no horizontal overflow and retains save/cancel controls.

这些图片仅证明真实组件在虚构数据下的布局和状态。真实账号、CC/Codex 运行及最终部署版本的验收记录另见 #1284。


## Existing production subscription baselines (before Profile deployment)

On 2026-11-05, the existing authorized Owner used the existing Claude Code and Codex subscription connections. Each task produced an exact small text file, independently reviewed its committed contents, completed the legacy Verify stage, and was accepted through the normal Owner UI. These runs establish real native subscription connectivity only; they do not prove the Agent Profile feature or the new flowVersion 2 behavior.

| Route | Task | Actual model | File SHA-256 | Owner outcome |
| --- | --- | --- | --- | --- |
| Claude Code / claude_code_cli | ALEX-58 | claude-haiku-5-5 | 2e17c96148b6c268a52d6be7394c4b7ae8f32120933da541492ea7d42492ba4f | Accepted |
| Codex / codex_cli | ALEX-56 | gpt-6-luna | 759e95464752666d035734902a3b173cd35ce27b82cffe0a4407eaf5d484fc57 | Accepted |

Evidence: [CC identity](cc-baseline-identity.jpg), [CC accepted](cc-baseline-accepted.jpg), [Codex identity](codex-baseline-identity.jpg), [Codex accepted](codex-baseline-accepted.jpg), [structured baseline receipt](subscription-baselines.json).

The DeepSeek API path was explicitly excluded by the user because the account is unfunded. No balance probe or paid API execution was performed.

## 最终隔离构建与正常 HTTP 验收

提交 `5190c20497d1ffe2d7540def2c1fbf0d422448dc`、tree `c1b99368abf14055fc744ca4dbb1694b9f7a3e33` 在 Docker Cloud Sandbox Large（8 vCPU / 16 GiB、Node 24、PostgreSQL 17）完成完整 `pnpm build`，退出码 0。严格部署身份校验绑定同一 SHA 和 `http://localhost:3110`，使用正常 TestAccountPool 注册、登录，27/27 HTTP 断言通过。清理复核于 2026-11-05T02:04:53Z 确认租约、有效会话、预览及所属进程均为零。

[逐条 HTTP 验收脱敏收据](isolated-final-5190c204.json) · [最终回归与新增轮询规则核对](verification-summary.json)。收据经过现有 evidence audit；没有账号标识、密码、Cookie、令牌、私密 headers 或 descriptor 密钥。套件有覆盖重叠，不将不同套件数量累加成唯一测试数。

[PR #1297](https://github.com/alexj11324/Mikka/pull/1297) 的 exact-head [CI](https://github.com/alexj11324/Mikka/actions/runs/41952290490) 全部结束：27 success、5 按 PR 条件 skipped、0 failure。已 squash merge 为 `514030294dcdc68b2d9ca4a977ce04b298b37e6f`，保留合并时的最新主分支。此节记录隔离验收；最终生产 Profile 协作证据将在部署和真实执行完成后补充。
