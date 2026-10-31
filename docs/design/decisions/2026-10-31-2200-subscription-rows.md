# 模型与额度: two rows, sign-in stays in the row

- Date: 2026-10-31
- Source: Alex: 「只显示两排」; on the reviewed Artifact of seven states: 「可以,照这个实现」
- Rule: R-39, R-40
- Replaces: the 「连接订阅」 button and dialog in Figma V06 and ST-10; S-AF's 查看用量

The page always shows one row per provider. 连接 turns into a spinner and
连接中 while the browser opens; the row returns to 连接 if nothing comes back.
A sign-in the browser can't finish (the paste on web, the device code) opens
inside its row, in the one card. A failure adds a warning line to the card and
no row. There is no success sentence: the row itself says 已连接.

Quota is one block per window, as Claude's own usage panel: the name on the
left and the reset time and percent left on the right, above a full-width
meter (Alex: 「你放在这个线上边不行吗」, replacing V06's values beside the meter).
The update time shows once under the card. 断开 sits in the row's ⋯ menu. 重新连接 shows only on a row that needs it,
never in the menu of a healthy connection: starting it clears the stored
credential at once, so one stray click would lose a working subscription.

Accepted frames: Figma page 733:28177 (states 1 to 7).
