# Each bot picks its model in its own chat

- Date: 2026-10-31
- Source: Alex, relayed by the coordinator session: 「在 BOT 上面可以加一个模型选择器…我们就不在设置里面设置了，单独就说你想用什么模型都可以」
- Rule: R-11 changed
- See also: [orchestration](../orchestration.md) § 2 (resolution order, quota and a credential that disappears) and § 3 (model → Agent)
- Replaces: the Coordinator and per-bot model rows in 设置 › 工作区 › Bot 与 Agents

Model choice moves out of settings and into each bot's chat, the
Coordinator's included. The look is main's own composer and menu (Alex: the
running app on main is the only design source); this file fixes the content.

- **Where.** A chip in the composer's bottom bar, beside 「+」: the model's mark,
  its name and ⌄. It opens a menu.
- **Menu, in order:** 「Mikka 默认」 (点数); one group per subscription the
  person can use here, named by its plan (「Claude Max」, 「ChatGPT Pro」, no
  「我的…」: everything but a share is the person's own); 「API Key」 (按量);
  「团队成员分享的」, each item named with whose key it is (「林同学的 Key」);
  then 「管理 API 与订阅 ›」 to the account's 模型 page. It opens right above
  the chip, left-aligned with it, with main's `DropdownMenu` styling. A
  group with nothing in it is left out. Only credentials the resolver can use
  in this workspace are listed. The Coordinator only uses its own person's
  credentials, so its menu has no 团队成员分享的 group.
- **Refresh.** A refresh icon sits at the right of 「管理 API 与订阅」
  (「刷新模型列表」). It asks each listed subscription for its models and
  re-reads what the person can use. Opening the menu refreshes too, in the
  background, over what the menu already shows. The icon turns while it works,
  the menu stays open, and a failure leaves one row, 「刷新失败，重试」. The
  phone's menu has 「刷新」.
- **Saved per bot,** in `bot_model_choices`. Mikka 默认 picked on purpose is a
  row with no binding; no row means nothing was picked. The choice applies to
  the bot's next runs; a run already going keeps its frozen model.
- **Nothing picked:** the chip shows what § 2 gives the next run.
- **Models only.** The Coordinator runs on Mikka's own harness, so its picker
  chooses a model and nothing else. A bot's threads take the Agent from the
  model (§ 3). The menu has no Agent picker.
- **A credential that disappears** (removed, unshared, out of quota) stays in
  the chip under its name, marked 不可用. The next run follows § 2's rules for
  quota and for a credential that disappears.
- **Settings.** Bot 与 Agents loses the Coordinator and per-bot model rows. The
  account's 「API 与订阅」 keeps the credentials, the sharing and
  「订阅额度用完后，自动改用 API Key」 (on by default). Saved choices from the
  old rows keep working: they are the same rows.
- **Mobile.** The same picker in the composer, as a native menu like its 「+」.
