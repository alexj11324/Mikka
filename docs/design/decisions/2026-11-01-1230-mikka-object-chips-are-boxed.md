# Mikka object chips are boxed

- Date: 2026-11-01
- Source: Alex, looking at a reply that showed a task as a status ring, an
  underlined 「ZHIX-4」 and an underlined title: 「这个应该是要用一个 chip 把它框住
  的，怎么没有框住呢？你看看人家做得多好。」 He attached a reference: light,
  rounded chips with an icon and an accent title, no underline, the whole chip
  clickable (「⊙ Mikka 设计稿」「⊘ 外壳按 Figma 原型重做」「⧉ Mikka 外壳验收」).
  Relayed by the coordinating session.
- Rule: R-15
- Replaces: the 「task and run chips」 part of the `decisions.md` row of
  2026-10-31 on source chips (struck there)

The 2026-10-31 row made one unboxed style for reply sources, task and run
chips, and links. Alex's words then, 「我觉得没有必要加方框吧。你像他那样子做呢，
就图标单独放，然后右边直接是网址」, were about web addresses and sources only.
Extending them to task and run chips was an inference, not his decision; #668
shipped that inference. This corrects it.

- Web sources and links: unchanged, no box (R-14).
- Mikka objects (task, thread/run): a boxed chip. Faint accent fill from a
  token in light and dark (`--object-chip`, hover `--object-chip-hover`),
  small radius and padding, the status or type icon, then the title in the
  accent (`--object-chip-foreground`) with no underline. The chip does not
  break across lines; a long title truncates. The whole chip is the click
  target and opens the object.
- The hover card stays (Mikka · number, title, status, priority). The chip
  carries only the title; the number moved to the hover card.

Alex gave the reference and asked for the change outright. That is his
confirmation under `2026-11-01-0330-ui-figma-and-skill-review-before-code`
step 3, so this change goes to code without a Figma page.
