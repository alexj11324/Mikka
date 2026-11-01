# The person's own E2B key is enough for cloud runs

- Date: 2026-11-01
- Source: Alex, relayed by the coordinator session for the MVP blocker where a
  dispatched run answered 「这个任务需要一台电脑来跑」 although the person had
  their own E2B key: cloud tasks waited on `MIKKA_CLOUD_COMPUTER_TASKS=1` and a
  hand-made bot cloud runtime. Alex: 「如果说用户提交了这个 E2B 的 API，那就可以云端；不然的话，只能本地或者是他们自己的服务器」
- Rule: —
- Replaces: —
- See also: [run machine fallback](2026-10-31-2200-run-machine-fallback.md),
  which still sets the order; there is no Mikka-hosted or platform-key cloud

Cloud runs happen only on the person's own E2B key, and having that key is
enough: no host flag has to turn cloud tasks on. `MIKKA_CLOUD_COMPUTER_TASKS=0`
is a kill switch for a live incident; unset or any other value leaves them on.
A workspace admin turns computer use off with its 「电脑」 policy (deny), and
dispatch then skips the cloud.

With no key, a run never goes to the cloud and no cloud runtime is created: it
runs on the person's own device or server with 「允许自动调度」, else the bot
shows the card (填入 E2B Key / connect a computer).

With a key, a bot with no cloud runtime gets one when its first cloud run is
dispatched, with no manual step: its cloud computer is woken on that key and
its runtime recorded. The runtime's Agent uses the owner's own connected
subscription for its harness when nothing is bound yet; a saved binding wins.
This is idempotent: a second dispatch reuses the runtime and the binding. When
the cloud refuses (E2B refuses, the worker cannot start), the run takes the
next step of the fallback order.

The Coordinator is a bot too (glossary). Each owner has one hidden
Coordinator row per workspace (`bots.kind = 'coordinator'`), created on its
first cloud dispatch. It owns the Coordinator's cloud runtime, so a run the
Coordinator dispatches goes to the cloud the same way and still never borrows
another bot's runtime. Its runs stay the Coordinator's (`agent_runs.botId` is
null), and the row is never listed: not in the bot list, admin lists, usage,
groups, exports or model tools. A person may still name a bot "Coordinator".

How it is built: `lib/cloud-computer-flag.ts` holds the switch;
`lib/computer/auto-runtime.ts` creates the runtime from `dispatch_run`;
`cloudReady` in `lib/rule-dispatch.ts` needs the key, the bot and a policy
that is not deny, not an existing runtime.
