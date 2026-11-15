# Factory flow follows Warp Factories; acceptance is its own report page

- Date: 2026-11-04
- Source: Alex, in the coordinator session, after reviewing the redesign
  (Figma `zPe5LKycb2XuT1ivCLRw07`, pages 「待 Alex 确认 · Factory 任务流程」 935:2
  and 「Warp vs Mikka 逐步对照」 952:6): 「可以改。同时我认为这个验收页不应该放在这个
  详情页里面，应该是专门打开验收页统一来看……截图之类的东西……你放在一页不就好了吗？
  ……我希望它能够验收页能够是 HTML……或者是 Markdown 的形式。」
- Rule: —
- Superseded by: [2026-11-08-2328](2026-11-08-2328-factory-visual-evidence-required.md)
  only for rule 2's UI-only default recording and handoff without visual evidence.
  Every other rule remains in force.
- Replaces: in `2026-11-03-0415-all-dispatch-through-factory.md`, the clause
  "execute, then independent review, then independent verification, then
  acceptance — and none of them may be skipped", rule 2 (the host always
  dispatches review and then verify), rule 3 (the acceptance card on the task
  page) and Decisions 5 (asking the person once for a verify command). Every
  other part of that decision still holds: every dispatch is a Factory task, the
  host chooses the model, and agents never merge.

## The flow

Modelled on Warp Factories (docs.warp.dev/factories: how-factories-work,
factory-agents, factory-inbox; `warpdotdev/warp-factory-examples` default
agents).

1. **Stages are** 分诊 → 方案 → 实现 → 审阅 → 交给你 → 完成, or 已取消. They are not a
   fixed pipeline. The shortest path that meets the quality bar is taken: a
   clear request skips 分诊, and a small change skips 方案. Work can enter at
   any stage, and a revision goes back to the stage that owns it. A skipped
   stage is not shown anywhere.
2. **Verification belongs to 实现.** The agent that implements also runs the
   tests and checks and records the visual evidence (video by default for UI).
   There is no separate verify stage. When something cannot be verified, for
   example because no end-to-end command exists or can be inferred, the item is
   marked **未验证** with its reason, and the task still moves on to 交给你. The
   person is not asked for a command.
3. **审阅 runs once per task.** Its verdict is one of 通过, 需要修改 or 需要你判断.
   Clear findings go back to 实现 on the same PR and are then handed to the
   person, with no second review. Ambiguous findings go to the person.
4. **The person steps in at three points only:** approving the 方案 (a draft
   PR), answering a question, and reviewing and merging the PR. Agents never
   merge.
5. **完成 means merged.** A handed-off PR is 交给你. A PR closed without merging
   is not 完成.
6. **One voice.** Progress is written back into the task's own comment thread by
   the Bot that was @-mentioned: one plain-language comment per stage, with
   links. Internal runs (implement, review) appear only in the session view. The
   task page never shows 「派出线程」 rows.
7. **One status.** The task exposes one stage plus an optional 「需要你」 kind
   (方案待审 / 在问你 / PR 待审 / 阻塞 / 失败) and the time it has waited. A run's
   `needs_input` does not surface as the task's 「等待你」.
8. **Several tasks under one issue** become sub-issues, and each runs its own
   flow. The task page does not stack several Factory cards.

## The acceptance page

Acceptance is no longer a card or a tab inside the task. It opens the existing
**Artifact window** (R-56, `components/artifacts/artifact-window.tsx`), the same
one other Artifacts already use: the acceptance report on the left and the
thread that did the work on the right.

- **Left: the acceptance report, an Artifact.** It is an HTML or Markdown
  document that the implementing agent writes and review checks, in the spirit
  of a PR description's `## Verification` section. Everything is inline on that
  one page: each acceptance criterion with its evidence directly below it
  (screenshots shown as images, recordings playable in place, test and check
  output as text blocks). No button or chip has to be clicked to see evidence.
  未验证 items come first, with their reasons; then the review findings and how
  each was resolved, and the change summary (files, +/−) linking to the PR diff.
- **Right: the thread's conversation.** To ask for a change, the person just
  says it there, to the agent session that did the work. The change lands on the
  same PR and the report updates.
- **Top: the decision bar.** 查看 PR 并合并 is the one primary action; 要求修改
  focuses the conversation on the right.
- **Entry points.** The task page has a 验收 button (in the header and on the
  交给你 comment, whose body is a one-line summary such as 「4 项已验证，1 项未验证」).
  The inbox's PR 待审 item and the board open the same window.

This replaces the rule in R-56 that Factory acceptance is the 「验收」 tab of the
thread (decisions.md, 2026-10-30; Figma `358:8511`). Factory acceptance now
works the way every other Artifact's acceptance already does.
