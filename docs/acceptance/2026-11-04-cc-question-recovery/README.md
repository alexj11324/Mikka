# Planned CC question recovery acceptance

Status: approved plan; **not dispatched** at this commit.

The previous CC Factory v1 remains failed/cancelled with its original contract. This new case replaces the separately approved but never-sent plain v2 plan; it does not change either historical result.

- Canonical prompt: [prompt.txt](prompt.txt), exactly 3,435 UTF-8 bytes, SHA-256 `2516b01ed4d7f9661f784826d40cf80a3c84b1a79c38fa5ea1786cd3d2948f5d`.
- New file: `mikka-question-recovery-cc-20261104-1237.txt`.
- Contents: 52 bytes; SHA-256 `05767473d01dff511a6e38e59e8e3730f7e114283c2494c6b6ac48fadcb382a6`.
- Route: existing owner group → Coding Bot → normal Factory; official Claude Code `claude-haiku-5-5`, original subscription only.
- Gate: exact #1250 production build confirmed, original Codex 390 recovery completed, no active conflicting run, and the workspace's current preference fingerprint still equals the recorded single-Haiku post-state.

Execute must create and actually check the new file before calling the existing ask_human tool with a genuine decision question. It must wait for the Owner's normal answer. The continuation then submits the preserved file without rerunning the creation or check commands. Review and verify independently inspect the fixed candidate with inspect_artifact and use only the host's strictly bound direct-predecessor command observations.

Record the actual question, answer, immutable recovery receipt, predecessor/continuation relationships, native run/claim/SID identities, fixed candidate, actual tool observations, source labels, and final Owner acceptance. Do not assume that a continuation starts a distinct native session; record the actual identity. Independent review and verify must remain independently executed checks.

A missing capability, missing/invalid receipt, changed candidate, quota problem or different model is an actual blocked/failed result. There is no permission expansion, synthetic pass, criterion rewrite or model replacement. No run IDs or results exist for this plan yet.
