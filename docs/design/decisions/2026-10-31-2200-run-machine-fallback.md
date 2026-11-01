# Where a run executes: own E2B, own auto-schedule device, else an error to act on

- Date: 2026-10-31
- Source: Alex, relayed by the coordinator session. A newly signed-up person may have no card, no E2B and no device; chat must never fail. Corrections the same day: 「MVP 不提供 Mikka 自己的 E2B/云沙箱」 (cloud only on the person's own E2B key); then the 「允许自动调度」 switch, and an actionable error instead of a silent queue.
- Rule: —
- Replaces: the `cloudComputerUnavailable` / `executionModelUnknown` refusals of `dispatch_run` when no machine is available.
- Implements: [orchestration](../orchestration.md) § 4 「Placing a new run」 for `dispatch_run`, which is the source of truth where the two differ.

**MVP: no Mikka-hosted sandboxes; cloud only via the user's own E2B key.**
Mikka runs no E2B account or sandbox pool of its own.

**「允许自动调度」, per device.** It is on by default for servers and off by
default for personal computers (Mac, Windows). Settings › 电脑 shows it next to
「允许调度」 on every device. Mikka picks only devices that have it on. A device
the person names (a label rule, a rule whose place is that device) is used as
asked.

A new run goes to the first machine that can take it:

1. **The person's own E2B cloud**, when there is a key and the bot's cloud
   runtime is ready. When that E2B refuses (its concurrency cap, quota, an
   invalid key, a failed start), it counts as no cloud: the queued cloud run is
   ended so it is not left stuck, and the next step applies.
2. **The person's own online device with 「允许自动调度」 on**: a server first,
   then the default rule's device, else the most recently seen one.
3. **Otherwise an error the person can act on.** It is not a silent queue.
   Chat keeps working; the model is resolved as usual, so a person with no card
   replies on Mikka 默认
   ([bots reply on Mikka 默认](2026-10-31-2110-bots-reply-on-mikka-cloud.md)).
   The bot shows one card, 「这个任务需要一台电脑来跑」, whose rows depend on
   what the person has:
   - 「允许这台电脑自动调度」, for an online personal computer with the switch
     off. It turns the switch on and answers, so the bot dispatches again.
   - 「在这台电脑上启用」, when the person has no device at all.
   - 「填入 E2B Key」. Saving the key answers, so the bot dispatches again.
   - 「让服务器重新上线」 when they have a server (it opens Settings › 电脑),
     else 「连接我的服务器」.

**When a machine goes away** (this replaces the 「设备离线时」 setting, which is
removed from Settings › Bot 与 Agents; nothing waits on an offline device any
more):

- A run whose device went offline (its lease ran out) continues on the person's
  own E2B cloud when they have one, else on another of their devices with
  「允许自动调度」 on (servers first), else it ends and the bot shows the same
  card. A rule whose device is offline takes the same order for a new run.
  Where the run went is the `run_retried` event's `movedTo`
  (`{ kind: 'cloud' }` or `{ kind: 'device', deviceId }`); the thread view
  shows it.
- A cloud thread whose sandbox is gone gets a new sandbox for the same thread,
  from its workspace snapshot, continuing from the uploaded checkpoint.
- There are no Mikka caps on thread machines; the person's own E2B account sets
  the limit.

Personal E2B keys (each member brings their own) are a separate change.

Orchestration principle (agreed with Alex): the run interface is uniform. Three
things are decided independently: the **model**, by the subscription rules; the
**machine**, cloud by default and the person's own device by need or as the
fallback; and **concurrency**, per thread (one machine per cloud thread).

Sandboxes and snapshots hold software only. Credentials are never baked into a
template or snapshot; each run gets its credentials injected for that run.

Out of scope here: per-run disposable containers on a person's own server
(after MVP).

How it is built: `lib/rule-dispatch.ts` picks the machine and builds the card
(`machineUnavailableCard`). `lib/device-auto-schedule.ts` holds the switch's
default, and `devices."autoSchedule"` stores the person's choice
(`20261031234500_device_auto_schedule.sql`). The host draws the card's rows by
their action (`components/workspace/agent-decision.tsx`).
