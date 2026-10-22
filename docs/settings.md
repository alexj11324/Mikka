# Settings surface

The settings page is one continuous column of rows, not a stack of cards.
`components/settings/primitives.tsx` owns the shapes; product code only
supplies content.

## Rules

1. **One setting, one row.** Title and description on the left, value or
   control on the right. Use `SettingRow`.
2. **No surface on a row.** A row never carries `bg-*`, `rounded-*`, `border`,
   `shadow-*` or `ring-*`. `SettingsSection` already separates rows with
   `divide-y`; that is the only separator.
3. **Sections are surface-free.** `SettingsSection` renders a heading and a
   hairline-separated list. Do not wrap it in `Card`, `Frame`, or a
   `rounded-xl border bg-muted/30` div.
4. **Cards only at the "repeated subject" level.** When a category repeats a
   subject — one agent, one device, one member — one card per subject is
   allowed. The card contains rows, not a grid of tinted boxes, and the card
   itself must not have a background colour.
5. **Navigation and search stay in the sidebar.** Do not build a second list,
   selection region or scroll container inside the panel.

## Why

A screen with ten settings and ten cards has ten focal points, which means
none. Rows keep two focal points (label, control) and let the eye scan
vertically. `bg-muted` on a field breaks the row rhythm and makes neighbouring
fields read as unrelated components.

## Enforcement

`scripts/lint-ui.mjs` reports `settings/field-surface` when a settings or
agents file pairs `bg-muted` / `bg-accent` / `bg-secondary` with a `rounded-*`
radius in the same `className`. The subject card itself is allowed as long as
it has no background colour.

The rule is a floor, not the whole contract: it catches the tinted-box pattern,
not every way to weaken the layout. Review still checks rules 3–5.
