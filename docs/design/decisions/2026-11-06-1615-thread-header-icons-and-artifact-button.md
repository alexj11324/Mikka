# Thread header: icons only, and an Artifact button that is always there

- Date: 2026-11-06
- Source: Alex, reviewing the run-location and PR review frames (Figma
  `zPe5LKycb2XuT1ivCLRw07`, page `1052:6875`): 「这些都只留图标，文字必须要 hover
  上去才能看得见，你不能够直接写在上面。」 and 「我在你的聊天界面并没有看到 Artifact
  按钮，这不正确。」 The design is otherwise accepted.
- Rule: —
- Spec: [`thread-run-location.md`](../thread-run-location.md)

## Rule

1. After a thread's title the header shows icons, not words: where it runs
   (cloud, laptop, server, with its status dot) and the Agent's mark. Names
   and 「<Bot> 派出」 appear on hover (hover card or tooltip) or, on iOS, on tap.
2. An open thread's header always has an Artifact icon button. It is disabled,
   with the reason in its tooltip, until there is an Artifact; then it opens
   the Artifact window. A status dot shows the PR's state.
3. The message that finishes a thread carries its Artifact card, in the thread
   and in the bot's (or Coordinator's) chat.
4. The button and card say 「Artifact」, never 产物 (glossary).
