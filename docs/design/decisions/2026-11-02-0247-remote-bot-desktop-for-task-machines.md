# Task machines drive their Bot's desktop through the server (proposed)

- Date: 2026-11-02
- Source: Alex, relayed by the coordinator session: a run that needs a
  desktop but lands on a task machine (E2B's `claude` or `codex` template, no
  desktop) is not refused; its Agent operates the Bot's own desktop remotely.
  Not yet decided: this file is a draft for Alex.
- Rule: —
- Replaces: in part, `cloud-computer-backend.md` § 2 "Desktop on demand … It
  never moves to another machine"

## Words

| Word | What it is |
| --- | --- |
| **Bot desktop** | One display on the Bot's computer (`bot_desktops`), with the Bot's own browser profile and logins. One per Bot. |
| **Desktop lease** | The right of one run, or one person, to drive a Bot desktop now. Today only a person's takeover is a lease (`control='user'`, `controlUntil`); runs share the display. |
| **Task machine** | A repository thread's own sandbox, built from E2B's `claude` or `codex` template: the Agent and Mikka's worker, no desktop (decision 2026-11-01-2335). |
| **Run** | One `agent_runs` row: one attempt of a thread, claimed by one device under a run lease (`leaseExpiresAt`). |
| **Computer broker** | The daemon part that accepts a run's computer tool calls, applies the computer policy (`computer-action` judgment, person review) and hands approved calls to a driver. |
| **Driver** | The program that performs a call on a display (`cua-driver`, behind `lease-driver.py`). |

## Ownership and lifetime

- **Bot desktop:** owned by the Bot (and its owner, in a workspace). Created on
  the first wake, lives on the Bot's computer, is paused with it and ends when
  the Bot or its computer is deleted.
- **Desktop lease (proposed):** owned by one run or one person. Taken at the
  first forwarded action, renewed by each action (2 min), released when the
  run ends, stops, loses its run lease, or a person takes over.
- **Task machine:** owned by one task (decision 2026-11-01-1410). Created for
  the task's first run, paused between runs, ended with the task.
- **Run:** owned by its thread. Queued, claimed under a 90 s run lease, renewed
  by its device, ended once.
- **Computer broker:** owned by one daemon (one machine). Today only the Bot's
  computer has one; proposed: every task machine gets one that forwards.
- **Driver:** a process on the Bot's computer, one per call.

## Invariants

1. A Bot desktop has at most one lease holder at a time: one run or one person.
2. A run that does not use a desktop holds no desktop lease and is never held
   back by one.
3. A lease ends when its run ends, stops or loses its run lease.
4. Only the device that holds the run's lease, through that run's live run
   lease, can make the Bot desktop act; every action is checked again at the
   moment it runs.
5. A run that needs a desktop is never claimed by a machine that cannot reach
   one.

## Checked against the code (origin/main d45dbbb, plus PR #898 head 2b3d324)

- Invariant 1 is not held anywhere today, and not by #898 either: there is no
  per-run lease. `executeDriver` takes a shared lock
  (`packages/daemon/src/computer/driver.mjs` `flock -s`), so the Bot's own runs
  and any thread bound to the Bot interleave actions on one display. Only a
  person's takeover is exclusive, and `lease-driver.py` does not check `epoch`.
- Invariant 2: before #898, `claimCloudRun` (`lib/computer/claim.ts` `held`)
  held a run on a task machine while a person controlled the Bot desktop. #898
  skips that check when the device has no desktop.
- Invariant 5: #898 refuses, at claim (409, the run stays queued), a run with no
  remote on a device without a computer broker. Before #898 every claim from a
  task machine was refused (claim route required `computerBroker`), which broke
  all repository tasks.
- Gap kept by #898: a run on a task machine gets no `computer` in its
  assignment, but its policy keeps `computer_use` at the workspace default.
  Nothing can act on it (no broker), so this is cosmetic.
- `claimCloudRun` returns only `permission: 'allow'` and refuses otherwise
  (`lib/computer/claim.ts`), so cloud runs never go through person review today.

## What forwarding would be (design A)

1. The task machine's daemon gets a computer broker whose driver is remote:
   `execute` posts the approved call to a new `POST /v1/runs/:runId/computer`.
   The `computer-action` judgment and the review ledger stay in that broker.
2. The route fences each action like screen captures do
   (`lib/captures/screen.ts`): the workspace policy lock, run, device and token
   rows, live run lease, no stop, policy not `deny`, no person in control; it
   takes or renews the desktop lease (`bot_desktops.holderRunId`,
   `holderUntil`, a new `epoch`).
3. The server runs the call on the Bot's computer with the owner's E2B key
   (`connectComputer` + `commands.run`) through a one-shot runner that applies
   `lease-driver.py`'s checks plus `epoch` and holder, then `cua-driver`.

Rejected: a signed grant straight to the Bot computer's gateway (a new public
driver port, revocation lags the grant), and relaying through the Bot
computer's daemon (cross-device run ownership).

Cost: roughly L. Daemon broker and link (M), new route and lease logic (M–L),
runner script and install manifest (M), claim, reviews, captures and store
changes (S–M each), one migration, tests and one live E2B acceptance.

## The risk Alex has to weigh

The Bot desktop is a full session as `user` with passwordless sudo (decision
2026-11-01-2335): XFCE can open a terminal. An Agent on a task machine that can
click on it can reach root on the Bot's computer, every Bot display of that
owner, the Bot computer's worker credential, the viewer and sub-agent signing
keys, and the Bot browser's logged-in sessions; it also reads untrusted
repository content. That removes the one-task-one-sandbox isolation (decisions
1312, 1410) for any task that uses the computer. Keeping every forwarded action
under person review limits it, but cloud runs are `allow` today.

## The simpler alternative

A run that needs a desktop starts on a task machine built from the `desktop`
template (the release already builds it) instead of `claude` or `codex`: its own
desktop, no Bot logins, the documented "own machine" rule kept. The cost is a
slower start (4.83 s against 0.39–0.59 s) and a larger machine for those runs
only.

## Until this is decided

#898: a run that needs a desktop and lands on a task machine is refused at
claim and stays queued. Whichever way Alex decides replaces that 409.
