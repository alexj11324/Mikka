# A failed reply stays under the message; Mikka 默认 follows the chat's workspace

- Date: 2026-11-02
- Source: Alex, relayed by the coordinator session: 「如果用不了，应该有弹窗提示，而不是直接跳转回 API Key」; 「报错必须一直留在对话里（在出错的那条消息下面），不能自动消失」; 「如果说点数不能用的话，那就不应该显示在这个地方呀。」
- Rule: —
- Replaces: —

**A reply that failed stays in the chat.** The reason sits under the
person's message that the failed turn was answering, and it is still there
after the next turn and after a reload. The newest failure keeps its way on
under the message (重试, and 验证银行卡 / 打开计费 / 连接订阅 as the
person's state allows). An older one keeps only its reason.

**Picking a model never silently switches to another.** Picking Mikka 默认
keeps Mikka 默认, including in a chat that had an API key model picked
before.

**The model menu follows the chat's workspace.** Mikka 默认 is listed only
when that workspace has points to use: its own, members' shared points, or,
in a team with one member, that person's own (the shared one-member rule
lives in the 「一个人也是一个工作区」 work). The menu shows that workspace's
available points and never another workspace's. Where points are turned on
(「我的点数也可用于这个团队」, buying points) is the 计费 page. The menu
change waits for Alex to accept the frames on Figma page 「待 Alex 确认 ·
Mikka 默认不可用提示 · 2026-11-02」 (`848:2`).
