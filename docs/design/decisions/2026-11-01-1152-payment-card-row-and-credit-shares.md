# Credit shares in 计费 › 付款; the payer row names the card, not an action

- Date: 2026-11-01
- Source: Alex, on the Figma frames for credit shares (page 「待 Alex 确认 ·
  点数分享给团队（2026-11-01）」, node `790:50`), relayed by the coordinator
  session: everything accepted except the admin row 「林一 的卡 · 正在支付」.
  「正在支付」 reads as a charge in progress, while usage is charged as it
  happens. The row should say whose card pays for the team, e.g. 「付款卡」 on
  the left and 「林一的卡」 on the right, with no 「正在…」 status word; fix it on
  main too (#692), in zh and en.
- Rule: R-40, C-01
- Replaces: the 「{name} 的卡 · 正在支付」 row of
  [2026-10-31-2225-bindings-belong-to-the-person](2026-10-31-2225-bindings-belong-to-the-person.md)

In a team's 计费 › 付款:

- 我的点数也可用于这个团队: any member may let the team spend their own
  credits (decision 2026-10-31-2300 item 4). The team's own balance pays first,
  then sharers' balances, oldest share first. Leaving or a suspension ends it.
- Admins see 分享点数的成员 with the sharers' names.
- The payer row reads 「付款卡 · 林一的卡」. While a released card is in its grace
  period, the value adds the date it stops: 「林一的卡 · 11月8日 停止支付」.

Accepted frames: Figma `zPe5LKycb2XuT1ivCLRw07`, node `790:50` (member and
admin views), with the payer row as above.
