# main is the design; superseded Figma drafts are archived at once

- Date: 2026-11-01
- Source: Alex, after sessions kept building on stale Figma frames:
  「现在真实在跑的…命上面的代码…找到对应的那个 figma 的稿。如果说没有
  figma 的稿，那你就重新画。只要是不是在命上面的，那都是废稿。废稿的话，
  要么删，要么移到那个 archive 里面去。」 and 「每次这废稿不删也是有问题的吧？」
- Rule: —
- Replaces, in part: the 「Accepted Figma frames」 table in `decisions.md`
  where it names pages that are now in 归档.
- Superseded in part by: [2026-11-01-1440-dev-workflow-local-first](2026-11-01-1440-dev-workflow-local-first.md) (merging through integration batches)

## Rule

1. **The running app on `main` is the design.** When a Figma frame and `main`
   disagree, `main` wins, unless the frame is a draft Alex is reviewing now.
   A new design starts from a screenshot of the real app on `main`, never from
   an older Figma frame.
2. **The Figma file (`zPe5LKycb2XuT1ivCLRw07`) holds only:**
   - 「main 现状」: real screenshots of `main`, one frame per screen;
   - pages whose frames match `main` (today: 「组件库 · 统一」 and
     「看板卡片 v1 · 定稿 · 已上 main」);
   - at most one 「待 Alex 确认」 page per open topic.
   Everything else is in 归档 (`177:1320`) with the prefix
   「已废弃 · <原页面名> · 」, or deleted.
3. **A draft Alex rejects or replaces goes to 归档 in the same session**, not
   later.
4. **A PR that implements a draft archives the draft** and replaces the
   matching 「main 现状」 frame with a screenshot of the merged screen. The
   session that drew the draft owns this.
5. Code comments, decision files and PR descriptions cite this decision or a
   rule id, not a Figma node of a draft.
6. Mobile pages are out of scope until the mobile MVP ships.

## State on 2026-11-01

- Page 764:5189 「main 现状 · 2026-10-31（以代码为准）」: 40 desktop screens of
  `main` at 7758b19 (light, 1440).
- Page 714:5283 「看板卡片 v1 · 定稿 · 已上 main（#634）」: card parts and
  states, plus 8 real board screenshots; the old whole-board frames are in
  归档. Differences between the card frames and `main` are being fixed in
  code.
- 25 pages moved to 归档 and deleted, including every 2026-10-31 draft
  (API 与订阅, model picker, execution rules, models and quota, thinking and
  tool calls), 设置 v3 and v4, Factory, 工作流桌面端 and the 待确认 drafts.
- The three mobile component pages are kept and marked 「手机端 · 未核对 main」.
