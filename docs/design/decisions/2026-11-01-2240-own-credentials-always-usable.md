# A person's own subscriptions and API keys always work for them

- Date: 2026-11-01
- Source: Alex, relayed by the coordinator session: 「自己的订阅当然默认永远允许自己用……分享给工作区其他人，其他人可以用，那个是需要打开的。但个人是必须默认打开的，不允许出现调用不允许这种情况。」
- Rule: R-76 (exception)
- Replaces:
  - [2026-10-31-2225-bindings-belong-to-the-person](2026-10-31-2225-bindings-belong-to-the-person.md) rule 3: sharing a subscription into a team as the member's own choice (模型与额度 › 在这里使用我的订阅), and the admin switch 「允许成员使用个人订阅」.
  - [2026-10-31-2130-personal-vs-workspace](2026-10-31-2130-personal-vs-workspace.md): a team admin switching off personal subscriptions.
  - [orchestration.md](../orchestration.md) § 2 step 1: "allowed when the owner shared it there and the admin has not turned off 「允许成员使用个人订阅和 API Key」".

A person's own subscriptions and API keys run that person's own bots and
runs in every workspace they belong to, by default. There is no switch for
it, per workspace or anywhere else, and no admin switch limits it. A run
never fails because its owner's own credential is "not allowed" here.

Only 「分享给团队成员」 needs turning on: it lets other members' bots use the
credential in that workspace. It stays off by default, and it is the only
thing a workspace admin can switch off.

Unchanged: a credential never runs another member's bot unless shared; an
admin never sees or uses a member's credential; a paused (已暂停) row still
stops its owner's own use, because the owner chose it.
