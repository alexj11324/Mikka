# Where a run executes: own E2B, own device, else wait

- Date: 2026-10-31
- Source: Alex, relayed by the coordinator session: a newly signed-up person may have no card, no E2B and no device, and nothing should simply fail; runs fall back automatically. Correction the same day: 「MVP 不提供 Mikka 自己的 E2B/云沙箱」, cloud only through the person's own E2B key.
- Rule: —
- Replaces: the `cloudComputerUnavailable` / `executionModelUnknown` refusals of `dispatch_run` when no machine is available.
- Implements: [orchestration](../orchestration.md) § 4 「Placing a new run」 for `dispatch_run`, which is the source of truth where the two differ.

**MVP: no Mikka-hosted sandboxes; cloud only via the user's own E2B key.**
Mikka runs no E2B account or sandbox pool of its own, so there is nothing to
share out or bill for sandboxes.

A thread runs on the first machine that can take it:

1. **The workspace's own E2B cloud**, when the workspace has an E2B key and the
   bot's cloud runtime is ready. When that E2B refuses (its concurrency cap,
   quota, an invalid key, a failed start) it counts as no cloud: the queued
   cloud run is ended so it is not left stuck, and the next step applies.
2. **The person's own online device** (the desktop app, or a server with
   the daemon) with 「允许调度」 on: a server first, then the default rule's
   device, else the most recently seen one.
3. **Otherwise nothing fails.** Chat keeps working; the model is resolved as
   usual, so a person with no card replies on Mikka 默认 on the free allowance
   ([bots reply on Mikka 默认](2026-10-31-2110-bots-reply-on-mikka-cloud.md)).
   A task that needs a machine waits, consistent with 「设备离线时：等它上线」,
   and the bot shows one card, 「这个任务需要一台电脑来跑」, with
   「在这台电脑上启用」, 「连接我的服务器」 and 「填入 E2B Key」. When a
   device comes online, an E2B key is saved, or a cloud slot frees up in the
   workspace, the bot is woken once per waiting task and dispatches it again.

A label rule that names an online device still runs there; a rule whose device
is offline still waits on it under 「等它上线」, or tries the order above under
「改到云端运行」 and waits on that device when nothing else can take it. A new
person's default rule starts on the cloud when the workspace already has an E2B
key, otherwise on their online device.

Orchestration principle (agreed with Alex): the run interface is uniform. Three
things are decided independently: the **model**, by the subscription rules; the
**machine**, cloud by default and the person's own device by need or as the
fallback; and **concurrency**, per thread (one machine per cloud thread).

Sandboxes and snapshots hold software only. Credentials are never baked into a
template or snapshot; each run gets its credentials injected for that run.

Out of scope here: per-run disposable containers on a person's own server
(after MVP).

How it is built: `lib/rule-dispatch.ts` picks the machine, `lib/machine-waits.ts`
records the wait (a delivered `machine_needed` event) and wakes it (one
`machine_available` event per wait) from the device heartbeat, the E2B key save
and the end of a thread machine. The host draws the card's rows by their action
(`components/workspace/agent-decision.tsx`).
