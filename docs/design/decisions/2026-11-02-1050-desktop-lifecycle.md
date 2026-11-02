# The life of a cloud desktop: who holds it, when it is let go, and a person taking over

- Date: 2026-11-02
- Source: the coordinating Claude session asked for this record on 2026-11-02 so it can review it before it goes to Alex. Not yet confirmed by Alex. It builds on [0251](2026-11-02-0251-desktop-runs-get-their-own-machine.md) (a run that needs a desktop gets its own machine) and [0330](2026-11-02-0330-computer-policy-gates-computer-tasks-only.md) (the 电脑 policy gates computer tasks only).
- Rule: —
- Replaces: —

This record covers the desktop only: what a desktop is, who holds it, when it is
let go, and how a person takes it over and hands it back. Which machine, model,
Harness or priority a run gets is a dispatch rule: see the dispatch rules in
[orchestration.md](../orchestration.md). This record does not set any.

## Two kinds of desktop

- **The Bot's desktop** is the desktop on the Bot's own computer
  (`cloud_machines`, `bot_desktops`). It keeps the Bot's browser and logins.
  Only the Bot and its owner use it. No run executes on it: a run is claimed
  only on its own task machine (`lib/computer/claim.ts:46-50`, decision 0251).
- **A thread's desktop** is the desktop on the thread's own task machine
  (`thread_machines`, one machine per run). Only a computer task's machine has one. A repository task's machine
  has none (decision 2026-11-01-2335).

The two never share a display. A thread never drives the Bot's desktop
(decision 0251).

## The desktop lease

The lease is the record of who may act on a desktop right now. It is written to
the machine as `/run/mikka-viewer/<display>.json` (`DesktopLease`,
`lib/computer/e2b-provider.ts:10,99-112`). It carries the Bot, the owner, the
display, whether computer use is allowed (from the 电脑 policy and its
version), and who holds control.

- The machine's driver checks the lease before every action, under a shared lock
  on the display (`packages/daemon/src/computer/driver.mjs:228-230`,
  `scripts/e2b/lease-driver.py:19-26`).
- Publishing a new lease takes the lock exclusively, so no action runs on a
  half-written lease (`e2b-provider.ts:111`).
- The viewer re-reads the lease continually and drops a session whose epoch or
  control no longer matches (`scripts/e2b/viewer-gateway.py:38-41,77-80`).

## Who holds a desktop

At any moment a desktop is in exactly one of three states (`bot_desktops.control`):

| State | Who may act | Set by |
| --- | --- | --- |
| `idle` | nobody | the start state |
| `agent` | the agent working on that desktop | handback |
| `user` | the one person in `controlledBy`, until `controlUntil` | takeover |

- Viewing is not holding. Anyone allowed to view gets a view-only connection.
  Only the holder gets the control connection (`viewer-gateway.py:40,50-51`).
- A thread's desktop is never in `user`: its lease always has no
  `controlledBy` (`lib/cloud-computer/thread-machines.ts:367`). A person can
  view it but not take it over.

## A person takes over and hands back

These steps are for the Bot's desktop, the only desktop a person can take over.

1. **Take over.** The person asks to take control
   (`POST /api/bots/[botId]/computer/takeover`, `lib/computer/store.ts:153-156`).
   - If someone else holds it, the request is refused (409).
   - Otherwise the desktop becomes `user` for that person for 5 minutes, and its
     epoch moves on, so old viewer connections drop.
2. **Keep it.** While the person's viewer is open in control mode, each refresh
   extends the hold by 5 minutes (`store.ts:160-162`,
   `hooks/use-computer.ts:30-32`).
3. **Hand back.** The person hands back (`…/handback`), or closes the viewer
   while holding (`components/computer/computer-viewer.tsx:52-54`). The desktop
   becomes `agent`, the hold is cleared and the epoch moves on
   (`store.ts:158-159`).
4. **Lapse.** If the person stops refreshing, the hold ends by itself when
   `controlUntil` passes. No timer runs. The next check that reads the desktop
   treats it as not held (`store.ts:152`, `lib/agent-tool-approval/store.ts:35-41`).

While a person holds the Bot's desktop, work that would act on that desktop
waits; it does not fail. A waiting run is `paused` with
`pauseReason='human_control'` and keeps its earlier status in `resumeStatus`
(`store.ts:168-170`). It resumes on handback (`store.ts:172-174`), or on its
next liveness check once the hold has lapsed (`agent-tool-approval/store.ts:38-41`).

## When a desktop is let go

A thread's desktop lives and ends with its task machine (`thread_machines`):

- **The run ends and its task is still open:** the machine is parked (paused,
  run tokens revoked), so the next run of the same task can take it over
  (`workflows/thread-machine/steps.ts:9-16`, `thread-machines.ts:112-131,141-157`).
- **The task is closed or deleted:** the machine is ended, which stops the run,
  revokes tokens, removes its device and kills the machine
  (`thread-machines.ts:165-176,382-415`; swept by the run-recovery cron).
- **The machine is lost:** the run is retried on a new task machine; the old
  binding ends (`lib/run-leases.ts:191-204`).
- **A queued machine is idle for 15 minutes:** it is paused (`steps.ts:22-24`).

The Bot's desktop is never let go by a run, because no run holds it. It sleeps
when the Bot's computer sleeps (`e2b-provider.ts:60`, `lib/computer/reconcile.ts:30`).
A person's hold on it ends only by handback or lapse.

## The 电脑 policy

The workspace's 电脑 policy (decision 0330) decides whether a desktop may be used
at all. It is carried into every lease as "computer use allowed".

- **Under deny:**
  - a computer task is refused when queued and when claimed (0330);
  - a thread's desktop cannot be opened (`thread-machines.ts:362-365`);
  - the driver, the browser and the credential broker refuse to act
    (`lease-driver.py:21`, `lib/computer/browser-authority.ts:15-18`,
    `lib/credentials/broker.ts:37-41`).
- **Changing the policy:**
  - publishes new leases to the Bot's computer and every thread machine at once;
  - stops computer runs when it becomes deny (`store.ts:51-79`).
- **Repository tasks:** they run on machines without a desktop, so the policy
  never stops them (0330).

## Where the code does not match this record yet

Each of these is a gap to fix in its own PR. None is fixed here.

1. **A takeover pauses too much.** Taking over the Bot's desktop pauses every
   run bound to that Bot, including repository tasks on their own machines that
   never touch that desktop (`store.ts:168-170`). The claim likewise refuses a
   desktop run while the Bot's desktop is held (`claim.ts:53-54`), although that
   run uses its own desktop (decision 0251). By this record, holding the Bot's
   desktop affects only work on the Bot's desktop.
2. **A thread's desktop may not be started.** `ensureThreadMachine` clears
   `/run/mikka-viewer` and does not start the display or publish its lease; only
   `openThreadDesktop` does, and no screen calls it (`thread-machines.ts:279,368-369`).
   A computer task's driver would then find no lease. This needs to be confirmed
   on a running machine.
3. **A resumed thread machine is not watched.** Resuming a parked machine does
   not restart its lifecycle workflow, so it is not parked or ended when that run
   finishes (`thread-machines.ts:417`).
4. **A machine still running at the 12-hour watch limit is left running.** The lifecycle
   workflow stops watching after 12 hours and only pauses machines that are idle and
   queued (`workflows/thread-machine/workflow.ts:7-12`, `steps.ts:39`).
5. **A thread desktop's viewer access cannot be withdrawn early.**
   `thread_machines.epoch` never moves, so an issued view grant lasts until it
   expires.
6. **Deny does not stop viewing or taking over the Bot's desktop.** It only marks
   the lease "not allowed" (`store.ts:164-165`), so the driver refuses but the
   person still connects.
