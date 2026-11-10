# Design review uses hard checks and an independent reviewer

- Date: 2026-11-04
- Source: Alex, in the coordinator session, after his comments on the Factory
  redesign page: he asked why the Nielsen-heuristic self-review had not caught
  the problems he found, and approved the fix: 「好，就按这个来，规则写进去吧」.
- Rule: adds R-84 to R-89 and the "How a design is reviewed" steps
  (`rules.md`, Design review).
- Replaces: —
- Superseded in part by: [2026-11-09-0050](2026-11-09-0050-paid-blocks-as-shipped.md): for a paid block the side-by-side is against the library demo, not the live product.

The Factory redesign passed its author's own `ux-heuristics` self-score (8 to
9 on every screen), yet Alex found six problems in it:

- the acceptance window used an old chat style instead of the thread view;
- deliverables appeared in the task timeline;
- questions were asked on the task page instead of in the bot's chat;
- severity was shown in pale small text;
- the inbox left most of the screen empty;
- the acceptance entry was too small to notice.

These problems slipped through for three reasons:

- The author scored its own work.
- The heuristics are abstract, so each one has to be asked concretely.
- Two of the problems are product placement questions, which no
  screen-level heuristic covers.

From now on, R-84 to R-89 are pass/fail checks for every design. The review
that decides is done by an independent reviewer on full-size screenshots,
compared side by side with the live product. The author's self-score remains a
reference only.
