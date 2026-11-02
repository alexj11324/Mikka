# A failed reply stays under the message; Mikka 默认 follows the chat's workspace

- Date: 2026-11-02
- Source: Alex, relayed by the coordinator session: 「如果用不了，应该有弹窗提示，而不是直接跳转回 API Key」; 「报错必须一直留在对话里（在出错的那条消息下面），不能自动消失」; 「如果说点数不能用的话，那就不应该显示在这个地方呀。」; 「一个操作在同一个页面完成」; 「点数如果没了，用不了，你可以走 API 呀，还有订阅呀」
- Rule: —
- Replaces: —

**A reply that failed stays in the chat.** The reason sits under the
person's message that the failed turn was answering, and it is still there
after the next turn and after a reload. The newest failure keeps its way on
under the message, 重试 included. An older one keeps only its reason.

**Picking a model never silently switches to another.** Picking Mikka 默认
keeps Mikka 默认, including in a chat that had an API key model picked
before.

**Out of points is not a dead end.** When Mikka 默认 is refused for points
and the person has an API key or subscription they may use here, the turn
moves to the next usable model in 允许使用的模型, and that message says so
(「点数不足，已改用 X」). It respects the team's sharing switch and an
admin's ban on sharing. The explanation card shows only when nothing can
run.

**The way on happens where the person is.** The card's actions act on the
spot rather than opening another page: 「把我的点数用于这个团队」 in a team
with several members (it takes effect, then the turn runs again), buying
points in a dialog, and 改用我的 Key. A chat that is already on a model it
cannot use says so above the composer when it opens, with the same actions.

**The model menu follows the chat's workspace.** Mikka 默认 is listed only
when that workspace has points to use: its own, members' shared points, or,
in a team with one member, that person's own (`lib/workspace-solo.ts`). The
menu shows that workspace's available points and never another
workspace's.
