# Settings surface

Each section is a small heading over one card of rows, as in
Comma's 「模型与 API」 (decision 2026-10-30).
`components/settings/primitives.tsx` owns the shapes; product code only
supplies content.

## Rules

1. **One setting, one row.** Title and description on the left, value or
   control on the right. Use `SettingRow`.
2. **No surface on a row.** A row never carries `bg-*`, `rounded-*`, `border`,
   `shadow-*` or `ring-*`. `SettingsSection` already separates rows with
   `divide-y`; that is the only separator.
3. **One card per section.** `SettingsSection` renders the heading and one
   bordered card of hairline-separated rows. Do not nest more cards or tinted
   boxes inside it.
4. **Selects are filled.** A choice on the right is a fixed-width select
   button with the grey `--control` fill and no stroke (R-31): icon (R-74)
   and value, then a chevron.
5. **Cards only at the "repeated subject" level.** When a category repeats a
   subject — one device, one member — one card per subject is
   allowed. The card contains rows, not a grid of tinted boxes, and the card
   itself must not have a background colour.
6. **Navigation and search stay in the sidebar.** Do not build a second list,
   selection region or scroll container inside the panel.

## Layout

Settings render inside the app window (`SettingsFrame` in
`components/settings/settings-shell.tsx`): the window bar and icon rail stay,
the section list is the card's first column, and the section scrolls beside it.
There is no 「返回应用」; the rail leaves Settings. On phones the section list is
the sheet behind the header's sidebar button, with the rail items at its foot.

## Sections

- **Personal (account):** Preferences, Profile, profile memory (个人资料类记忆; bot and team memory stay in their workspace), Account (账户), Integrations, Devices (设备), API 与订阅. The same in every workspace.
- **Personal workspace:** every setting of the workspace itself: 常规 (no 转让; it cannot be deleted), Bot 与 Agents, 密钥与环境 (the person's own secrets for their runs), 用量 and 计费 (without 付款).
- **Team workspace (administration):** the same, plus what is between people: Members, Teams, 团队权限, 审计日志, 转让, 离开成员的 Bot, 付款 and 分享给团队成员 ([decision 2026-11-02-0216](design/decisions/2026-11-02-0216-personal-workspace-has-workspace-settings.md), with the full table).

Account holds how the person signs in: linking Google to the Mikka account.
Integrations holds connected apps (Gmail, Calendar, Notion, Slack, Linear,
Telegram), even when the app is a Google one.

## Why

A screen with ten settings and ten cards has ten focal points, which means
none. Rows keep two focal points (label, control) and let the eye scan
vertically. `bg-muted` on a field breaks the row rhythm and makes neighbouring
fields read as unrelated components.

## Enforcement

`scripts/lint-ui.mjs` reports `settings/field-surface` when a file under
`components/settings/`, `components/devices/` or `components/agents/` pairs `bg-muted` / `bg-accent` / `bg-secondary` with a `rounded-*`
radius in the same `className`. The subject card itself is allowed as long as
it has no background colour.

The rule is a floor, not the whole contract: it catches the tinted-box pattern,
not every way to weaken the layout. Review still checks rules 3–6.
