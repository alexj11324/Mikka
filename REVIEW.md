# Review rules

- UI copy has no filler (`docs/design/rules.md` R-40). Flag as blocking any new
  visible string that only explains the screen, narrates what will happen next
  or reassures in a full sentence: a sheet or dialog subtitle, small print such
  as 「…不保存，也不会给 AI 看」, a status line with a next step
  (「已登录，继续检查」). Reassurance is a mark (🔒 Secured by Mikka). A paid
  block's own text slots (a dialog subtitle it ships with) stay, filled with our
  strings ([2026-11-09-0050](docs/design/decisions/2026-11-09-0050-paid-blocks-as-shipped.md)).
