# Fixes push straight to main

- Date: 2026-11-03
- Source: Alex, through the coordinator session: 「流程改了，按 Alex 的要求：不开 PR，直接合到 main。」 and 「今天起修复类改动不开 PR，本地检查全绿后直推 main，由协调者在 main 上事后审查」
- Source, rule 4: Alex, through the coordinator session: 「先在本地或预览环境端到端验证，通过后再推 main，不准拿生产当测试环境。」
- Rule: — (process, not product)
- Replaces: [2026-11-01-1545-trunk-based](2026-11-01-1545-trunk-based.md) rules 1–3, for fixes

1. A fix opens no PR. When its local checks are green, it is rebased onto
   `main` and pushed there, without force.
2. The coordinator reviews it on `main` after the push.
3. A fix that touches credentials or auth: right after the push, its author
   sends the coordinator a summary of the diff and the test results.
4. Before the push, the change is verified end to end locally (a production
   build against an isolated database) or on a preview deployment with its
   own database branch. Production is never the test environment.

Other changes still follow the trunk-based rules.
