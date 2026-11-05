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
