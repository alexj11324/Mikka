# UI changes: Figma first, skill review second, code last

- Date: 2026-11-01
- Source: Alex, after a GitHub plugin page shipped with repository names piled
  into the connection card: 「这些东西都要用那个技能去审过，不能够直接做。你先画
  Figma，画完之后交给那个技能，包括这些 UI 美观的技能，你要让他们审过之后，才能够去
  做实现」
- Rule: —
- Builds on: `2026-11-01-0015-main-is-the-design.md`

## Rule

Every change a person can see (a new page or section, a changed layout,
component, state or piece of copy) follows these steps in order. A pure bug fix
that restores what `main` already shows is exempt.

1. **Figma.** Draw the change in file `zPe5LKycb2XuT1ivCLRw07` on one page named
   「待 Alex 确认 · <topic>」. Start from a screenshot of the real screen on
   `main` and reuse 「组件库 · 统一」. Draw light and dark at 1440 and every
   state the change has (empty, loading, error, filled, long content).
2. **Skill review.** Run `interface-design:design-review` and `unslop` (and
   `ux-copy` when copy changes) on the frames. Revise until no blocking finding
   remains. Keep both reviews' conclusions with the frames.
3. **Alex confirms.** The coordinator sends Alex the Figma link and the
   reviews. Nothing is implemented before he confirms.
4. **Code.** The implementation matches the confirmed frames. The PR attaches
   screenshots of the built screen next to the frames (light and dark, 1440).
   The coordinator looks at those screenshots before merging; green CI alone
   does not make a UI PR mergeable.
5. After merge, the draft page is archived and 「main 现状」 is updated
   (decision 2026-11-01-0015, rule 4).
