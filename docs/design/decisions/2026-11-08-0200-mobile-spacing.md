# Mobile spacing opened up, in theme tokens

- Date: 2026-11-08
- Source: Alex on TestFlight: chat list rows too small and cramped next to OpenBot's home, then 「把间距放大」 for the whole app (relayed by the coordinator with OpenBot and Comma as the references).
- Rule: `apps/mobile/lib/theme.ts` (`LIST_INSET`, `SPACE`, `AVATAR`)
- Replaces: the 16 pt list inset of 2026-11-06 and the per-screen paddings it set

All values live in `lib/theme.ts`; screens use the tokens, never their own numbers. Fonts keep their sizes.

| What | Value |
|---|---|
| Page side margin (plain and inset grouped lists) | 20 pt |
| A list row's vertical padding | 15 pt (a Bot row is 78 pt with its 48 pt avatar) |
| Chat row avatar | 48 pt; name 17 pt, preview 15 pt secondary, date on the right; no separators |
| Pinned tile avatar | 86 pt, the name under it |
| Between a row's title and its grey line | 4 pt |
| Between groups and sections | 30 pt |
| Below a group bar | 12 pt |
| Between a detail page's blocks | 20 pt |
| Between 活动 items | 16 pt |
| Settings | inset grouped, 30 pt between sections |
