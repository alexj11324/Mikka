# 资料库 can delete the person's own files

- Date: 2026-11-01
- Source: Alex, relayed by the coordinator session: 「自己上传的文件，在资料库里可以删除」
  ("资料库里删不掉自己的文件").
- Rule: R-51 (adds 删除 to 资料库)
- Replaces: —

- The right panel stays read-only except for this: in 概览 › 详情 › 资料库,
  each of the person's own files has 删除.
  - The button shows on hover or keyboard focus, and always on touch.
  - It asks first (「删除「名字」？」 · 取消 / 删除); nothing brings a file back.
  - A failed delete keeps the row and says so.
- 资料库 lists what the bot's threads handed over (decision
  2026-11-01-0050-mobile-chat-settings); the web reads the same list as the
  phone.
- 现状（非决定）：the server has no delete for these files yet (backend,
  open); until it does, 删除 reports that the file was not deleted. The phone's
  bot page does not offer 删除 yet.
