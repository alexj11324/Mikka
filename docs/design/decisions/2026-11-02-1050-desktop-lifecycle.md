# The life of a cloud desktop: viewing, operating, and when it is let go

- Date: 2026-11-02
- Source:
  - The coordinating Claude session asked for this record on 2026-11-02 and reviewed the first draft.
  - Alex then gave three rules, relayed by the coordinating session:
    - nobody can look at a thread's desktop;
    - on the Bot's desktop, an open window means watching, not operating;
    - who operates is decided by mouse and keyboard activity, with a 1-minute idle limit; a chat message to the Bot hands the desktop back at once.
  - This record writes those rules down for Alex to confirm.
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

- **Watching.** The owner opens the window and sees the desktop. While the window
  is open, access renews itself. Watching never stops the agent: the agent keeps
  operating while someone watches.
- **Operating.** Exactly one party operates the desktop at a time: the Bot's
  agent, or the person.
  - The person is operating while their mouse or keyboard has acted on the
    desktop within the last 60 seconds.
  - Operation passes back to the agent in either of two cases:
    1. 60 seconds pass with no mouse or keyboard input from the person;
    2. the person sends the Bot a chat message that asks it to do something.
       The agent may then act at once, without waiting the 60 seconds.

What follows:
- **An open window alone is not operating.** Someone who only watches never
  holds the desktop.
- **The person needs no take-over button.** Their input takes operation, and
  their silence or a chat message gives it back.
- **The agent waits; it does not fail.** While the person is operating, the
  agent's work on that desktop waits, and it continues once operation passes
  back.
- **Only times are reported.** The server learns that input happened, and when.
  It never receives what was typed or where the pointer went.

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
   its own desktop. By this record, the person operating the Bot's desktop
   affects only work on the Bot's desktop.
2. **A thread's desktop may not be started for its agent.** `ensureThreadMachine`
   clears `/run/mikka-viewer` and neither starts the display nor publishes its
   lease. Only `openThreadDesktop` does (`thread-machines.ts:279,368-369`). A
   computer task's driver would then find no lease. This needs to be confirmed
   on a running machine.
3. **A thread's desktop can still be watched.** `POST /api/threads/[runId]/machine
   {action:'desktop'}` issues a view grant (`app/api/threads/[runId]/machine/route.ts:17`,
   `thread-machines.ts:362-371`). By this record, nobody watches a thread's
   desktop, so that grant and its route go away.
4. **Operation is a fixed 5-minute hold, not input activity.**
   - Today a person explicitly takes over (`…/takeover`). That sets
     `control='user'` and `controlUntil = now + 5 minutes` (`store.ts:153-156`).
   - Every viewer refresh in control mode extends it by another 5 minutes
     (`store.ts:160-162`, `hooks/use-computer.ts:30-32`). So an open window
     keeps the hold with no input at all.
   - The viewer reports no input activity.
   - A chat message to the Bot does not give the desktop back.
   - By this record:
     - the viewer reports input times only;
     - the person operates while their last input is under 60 seconds old;
     - a chat message to the Bot hands operation back at once;
     - an open window alone holds nothing.
5. **A resumed thread machine is not watched by its lifecycle.** Resuming a
   parked machine does not restart its lifecycle workflow, so it is not parked or
   ended when that run finishes (`thread-machines.ts:417`; #956).
6. **A machine still running at the 12-hour watch limit is left running.** The
   lifecycle workflow stops watching after 12 hours and only pauses machines that
   are idle and queued (`workflows/thread-machine/workflow.ts:7-12`, `steps.ts:39`; #957).

## Open question for Alex

When the person closes the window while operating, does the agent get the desktop
back at once, or only after 60 seconds with no input? Today closing the viewer
hands back at once (`components/computer/computer-viewer.tsx:52-54`).
