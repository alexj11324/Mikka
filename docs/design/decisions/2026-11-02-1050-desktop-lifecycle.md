# The life of a cloud desktop: viewing, operating, and when it is let go

- Date: 2026-11-02
- Source:
  - The coordinating Claude session asked for this record on 2026-11-02 and reviewed the first draft.
  - Alex then gave his rules, relayed by the coordinating session: nobody can look at a thread's desktop, and on the Bot's desktop an open window means watching, not operating.
  - On how a person takes over the Bot's desktop and hands it back, Alex chose, after a comparison with Cursor, Devin, ChatGPT agent, Manus and Cloudflare: 「你按照其他家竞品的接手交还规则来做就行了，我们不额外加规定」. Take over and hand back are explicit actions. There is no idle timer and no activity rule.
  - It builds on [0251](2026-11-02-0251-desktop-runs-get-their-own-machine.md) (a run that needs a desktop gets its own machine) and [0330](2026-11-02-0330-computer-policy-gates-computer-tasks-only.md) (the 电脑 policy gates computer tasks only).
- Rule: —
- Replaces: —

This record covers only the desktop itself:
- what a desktop is;
- who may watch it and who may operate it;
- when it is let go.

Which machine, model, Harness or priority a run gets is a dispatch rule: see the
dispatch rules in [orchestration.md](../orchestration.md). This record sets none.

## Two kinds of desktop

- **The Bot's desktop** is the desktop on the Bot's own computer
  (`cloud_machines`, `bot_desktops`). It keeps the Bot's browser and logins. The
  Bot's agent works on it, and its owner can watch it and operate it. No thread
  run executes on it: a run is claimed only on its own task machine
  (`lib/computer/claim.ts:46-50`, decision 0251).
- **A thread's desktop** is the desktop on the thread's own task machine
  (`thread_machines`, one machine per run).
  - Only a computer task's machine has one; a repository task's machine has
    none (decision 2026-11-01-2335).
  - Only the thread's agent uses it. No person can watch it or operate it, and
    no screen offers a way in.
  - A thread that gets stuck is the agent's to resolve.

The two never share a display. A thread never drives the Bot's desktop
(decision 0251).

## The desktop lease

The lease is the record of who may act on a desktop right now. It is written to
the machine as `/run/mikka-viewer/<display>.json` (`DesktopLease`,
`lib/computer/e2b-provider.ts:10,99-112`). It carries:
- the Bot, the owner and the display;
- whether computer use is allowed, from the 电脑 policy and its version;
- who is operating.

How the machine enforces it:
- **The driver** checks the lease before every action, under a shared lock on
  the display (`packages/daemon/src/computer/driver.mjs:228-230`,
  `scripts/e2b/lease-driver.py:19-26`).
- **Publishing a new lease** takes the lock exclusively, so no action runs on a
  half-written lease (`e2b-provider.ts:111`).
- **The viewer** re-reads the lease continually and drops a session whose epoch
  or operator no longer matches (`scripts/e2b/viewer-gateway.py:38-41,77-80`).

## Watching and operating are two states

These rules apply to the Bot's desktop, the only desktop a person can reach.
They follow what Cursor, Devin and ChatGPT agent do: the person takes over
explicitly and hands back explicitly.

- **Watching.** The owner opens the window and sees the desktop live. Watching
  never stops the agent: the agent keeps working while someone watches.
- **Taking over.** The owner chooses to take over. From then on the person
  operates the desktop and the agent's work on it waits; it does not fail. If
  someone else already holds it, taking over is refused.
- **Handing back.** The person hands back, either with the hand-back action or
  by closing the window. The agent continues where it stopped.
- **While the window stays open,** the hold stays with the person. Nothing takes
  it back on a timer or from mouse or keyboard activity.

How the code does this today:
- Take over and hand back are `POST /api/bots/[botId]/computer/{takeover,handback}`
  (`lib/computer/store.ts:153-159`).
- Closing the viewer hands back (`components/computer/computer-viewer.tsx:52-54`).
- The open window renews the hold (`store.ts:160-162`, `hooks/use-computer.ts:30-32`).
  The 5-minute `controlUntil` only marks how a window that vanished without
  closing (a crashed tab, a lost connection) is detected. It is not a limit on
  a person who is still there.
- The agent's waiting work is `paused` with `pauseReason='human_control'` and
  resumes on handback (`store.ts:168-174`) or once a vanished window's hold has
  lapsed (`lib/agent-tool-approval/store.ts:38-41`).

Exactly one party operates the desktop at a time: the Bot's agent, or the person
who took over.

## When a desktop is let go

A thread's desktop lives and ends with its task machine (`thread_machines`):

- **The run ends and its task is still open:** the machine is parked (paused,
  run tokens revoked), so the next run of the same task can take it over
  (`workflows/thread-machine/steps.ts:9-16`, `thread-machines.ts:112-131,141-157`).
- **The task is closed or deleted:** the machine is ended. That stops the run,
  revokes tokens, removes its device and kills the machine
  (`thread-machines.ts:165-176,382-415`; swept by the run-recovery cron).
- **The machine is lost:** the run is retried on a new task machine, and the old
  binding ends (`lib/run-leases.ts:191-204`).
- **A queued machine is idle for 15 minutes:** it is paused (`steps.ts:22-24`).

No thread run holds the Bot's desktop, so no run lets it go. It sleeps when the
Bot's computer sleeps (`e2b-provider.ts:60`, `lib/computer/reconcile.ts:30`).

## The 电脑 policy

The workspace's 电脑 policy (decision 0330) governs agents using a computer. It
does not govern people. The policy is carried into every lease as "computer use
allowed".

- **Under deny, for agents:**
  - a computer task is refused when queued and when claimed (0330);
  - the driver, the browser and the credential broker refuse agent actions
    (`lease-driver.py:21`, `lib/computer/browser-authority.ts:15-18`,
    `lib/credentials/broker.ts:37-41`).
- **Under deny, for the owner:** the owner can still watch and operate the Bot's
  desktop. It is their own (#959).
- **Changing the policy:**
  - publishes new leases to the Bot's computer and every thread machine at once;
  - stops computer runs when it becomes deny (`store.ts:51-79`).
- **Repository tasks** run on machines without a desktop, so the policy never
  stops them (0330).

## Where the code does not match this record yet

Each of these is a gap to fix in its own PR. None is fixed here.

1. **Taking over the Bot's desktop pauses too much.** It pauses every run bound
   to that Bot, including repository tasks on their own machines that never
   touch that desktop (`store.ts:168-170`). The claim likewise refuses a desktop
   run while the Bot's desktop is held (`claim.ts:53-54`), although that run uses
   its own desktop. By this record, a person holding the Bot's desktop affects
   only work on the Bot's desktop.
2. **A thread's desktop may not be started for its agent.** `ensureThreadMachine`
   clears `/run/mikka-viewer` and neither starts the display nor publishes its
   lease. Only `openThreadDesktop` does (`thread-machines.ts:279,368-369`). A
   computer task's driver would then find no lease. This needs to be confirmed
   on a running machine.
3. **A thread's desktop can still be watched.** `POST /api/threads/[runId]/machine
   {action:'desktop'}` issues a view grant (`app/api/threads/[runId]/machine/route.ts:17`,
   `thread-machines.ts:362-371`). By this record, nobody watches a thread's
   desktop, so that grant and its route go away.
   Fixed: the route takes only `pause`, `resume` and `end`, and `openThreadDesktop`
   is gone ([1232](2026-11-02-1232-computer-policy-binds-agents-not-people.md)).
4. **A resumed thread machine is not watched by its lifecycle.** Resuming a
   parked machine does not restart its lifecycle workflow, so it is not parked or
   ended when that run finishes (`thread-machines.ts:417`; #956).
5. **A machine still running at the 12-hour watch limit is left running.** The
   lifecycle workflow stops watching after 12 hours and only pauses machines that
   are idle and queued (`workflows/thread-machine/workflow.ts:7-12`, `steps.ts:39`; #957).
