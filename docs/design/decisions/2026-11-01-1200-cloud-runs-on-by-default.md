# Cloud runs are on by default

- Date: 2026-11-01
- Source: Alex, relayed by the coordinator session for the MVP blocker where a
  dispatched run answered 「这个任务需要一台电脑来跑」 because cloud tasks waited
  on `MIKKA_CLOUD_COMPUTER_TASKS=1` and a hand-made bot cloud runtime. Cloud
  runs are on by default, like Devin, Codex cloud, Cursor background agents and
  Factory; features ship on and an admin turns them off.
- Rule: —
- Replaces: —
- See also: [run machine fallback](2026-10-31-2200-run-machine-fallback.md),
  which still sets the order and the credentials (the person's own E2B key)

Cloud computer tasks no longer wait for an opt-in. `MIKKA_CLOUD_COMPUTER_TASKS`
is a kill switch: `0` turns them off for a live incident; unset or any other
value leaves them on. A workspace admin turns computer use off for the
workspace with its 「电脑」 policy (deny), and dispatch then skips the cloud.

A bot with no cloud runtime gets one when its first cloud run is dispatched,
with no manual step: its cloud computer is woken and its runtime recorded. The
runtime's Agent uses the owner's own connected subscription for its harness
when nothing is bound yet; a saved binding wins. This is idempotent: a second
dispatch reuses the runtime and the binding. When the cloud refuses (no key,
E2B refuses, the worker cannot start), the run takes the next step of the
fallback order.

A run with no bot (the Coordinator) still never borrows another bot's runtime.

How it is built: `lib/cloud-computer-flag.ts` holds the switch;
`lib/computer/auto-runtime.ts` creates the runtime from `dispatch_run`;
`cloudReady` in `lib/rule-dispatch.ts` needs the key, the bot and a policy
that is not deny, not an existing runtime.
