# #1284 component visual review

These screenshots render the actual Agent Profile settings, editor and task selector in a Docker Cloud Sandbox production build with synthetic fixture data. They are component layout evidence only: no real account, credential, model call or final deployment acceptance is claimed. The fixture is outside the product repository and has no authentication or mutation API.

Captured 2026-11-05 UTC from the pre-rebase implementation working tree based on 2b25caad1608df6a2a54d5e18e798b3c9807ce89. Product UI source was later replayed onto fc2d401bde7b3f567b1288b01accd6fdeb433d0c. The PR records exact-head CI, isolated authenticated API acceptance and subsequent production acceptance separately.

Reviewed: desktop editor and dark list; 390px list/editor; default/empty and loading-error recovery; unavailable choices in the task picker. The 390px iframe has no horizontal overflow and retains save/cancel controls.

这些图片仅证明真实组件在虚构数据下的布局和状态。真实账号、CC/Codex 运行及最终部署版本的验收记录另见 #1284。
