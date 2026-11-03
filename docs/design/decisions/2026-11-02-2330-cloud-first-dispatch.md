# 云端 first, then a server, then a computer

- Date: 2026-11-02
- Source: Alex, relayed by the coordinator session: 有 E2B key 时优先在 E2B 云端跑；没有 key（或云端不可用）时派到这个人参与调度的服务器；两者都没有，才派到本机电脑. Then: 选「云端」就云端优先，选「本地」就服务器优先，电脑不管怎样都排最后; the settings page writes the order out (「依次用：云端 → 服务器 → 电脑」 / 「依次用：服务器 → 电脑」), then where a run goes now.
- Rule: —
- Replaces: [2026-11-02-1400](2026-11-02-1400-model-order-dispatch.md) on 运行位置 (云端 or 本地 as two exclusive places, 本地 the default)

运行位置 keeps its two settings, each trying places in order and moving to
the next only when no allowed model can run in the one before it:

- **云端** (the default): the person's own E2B cloud, then a server that
  takes part in scheduling, then a computer that does. A server running a
  later model in 优先使用的模型 goes before a computer running an earlier one.
- **本地**: a server, then a computer. Never the cloud.

The cloud is skipped up front when cloud runs are off, the person has no E2B
key of their own, or E2B already refused the key (cleared when the key is
saved again). A limit or template error is tried again. When the cloud fails
to start a run (any E2B refusal, or the worker never registers), that run is
ended and the same request goes to a server, then a computer; the result
carries `fallback: cloudUnavailable` and the reply names the place it got.
A computer the person names, or a run they put in the cloud, goes only there.

Credentials do not change the order: every model in 优先使用的模型 is a
connected subscription or an API key that Mikka holds, so each can run in the
cloud. A CLI signed in only on a computer is not in the list.

Every stored 运行位置 was the old default 本地, which no one could be told to
have chosen, so each moved to 云端 (all 7 rows on 2026-11-02, including one
whose list was edited: that flag is about the list, not the place). 本地 is
one switch away in 模型与订阅.

Settings show the order, then 会先用 from the same plan as dispatch:
「依次用：云端 → 服务器 → 电脑 · 会先用 云端」,
「依次用：云端 → 服务器 → 电脑 · 没有 E2B Key，会先用 <设备名>」,
「依次用：服务器 → 电脑 · 会先用 <设备名>」, or 「没有能跑的位置」. Without an
E2B key, 云端 rows stay ready; 填入 E2B Key sits on the 运行位置 row.
