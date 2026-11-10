# Reuse existing components in every design and build

- Date: 2026-11-04
- Source: Alex, in the coordinator session. He first asked about the Factory question screen: 「这里没有现成的组件可以用吗？比如 Questionnaire 之类的组件没有吗？」 He then asked for the rule to be written into every relevant document: 「有现成组件应该复用这条原则……没有的话你加进去，你看还有哪些文档里面需要加这个东西的，你麻烦你都加进去一下。」
- Rule: adds R-90 and extends R-84 (`rules.md`, Design review); adds a Questionnaire row to `components.md`; updates `README.md`, `spec-template.md`, `docs/review-checklist.md`, `AGENTS.md` and `.claude/skills/README.md`.
- Replaces: —
- Superseded in part by: [2026-11-09-0050](2026-11-09-0050-paid-blocks-as-shipped.md): reuse never swaps Mikka components or avatars into a paid block's parts.

The Factory redesign kept drawing look-alikes in place of components the product already has: an old chat style beside the thread view, hand-made quick-reply chips although shadcn `Questionnaire` (`components/ui/questionnaire.tsx`) exists, and invented thread tabs. Until now the reuse rule only existed in `components.md` for code, and in R-84 for chats.

From now on, before anything is designed or coded, the component for that job is looked up in a fixed order:

1. `components.md`;
2. the live screen that does the same job;
3. the libraries `components/reui/`, `components/ui/` (including components nothing imports yet), `components/motion/` and the OpenUI catalog.

If a component fits, the design draws it as its code renders it, and the code uses it. A new component is allowed only when nothing fits, and the same PR adds it to `components.md`. Independent design review checks this as R-90.

R-84 also now describes the thread view as the code renders it: the prompt comes first, followed by collapsible `ThreadSteps`; in `bare` mode there is no header and there are no tabs. The earlier text, which listed tabs the code does not have, is replaced.
