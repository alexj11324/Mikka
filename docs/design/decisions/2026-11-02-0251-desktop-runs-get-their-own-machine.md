# A run that needs a desktop gets its own machine with a desktop

- Date: 2026-11-02
- Source: Alex, in the E2B templates session: 「我建议也是，就是说单独起一台，就是说那个，带桌面的机器」, choosing this over an Agent on a task machine driving the Bot's own desktop remotely
- Rule: —
- Replaces: —

A thread that needs a desktop runs on its own machine that has one. It never
drives the Bot's desktop from another machine. The Bot's computer keeps its
desktop, browser and logins for the Bot, and one task keeps one sandbox
(decisions 2026-11-01-1312, 2026-11-01-1410).

Today this is how it already works: a thread with no repository (computer
work) starts from a snapshot of the Bot's computer, which has a desktop
(`lib/cloud-computer/thread-machines.ts`, `ensureThreadMachine`). A
repository task starts from E2B's `claude` or `codex` template, which has none
(decision 2026-11-01-2335). A run that needs a desktop and lands on a machine
without one is refused when it is claimed and stays queued
(`app/v1/devices/[deviceId]/runs/[runId]/claim/route.ts`, #898).

Rejected: forwarding the Agent's computer actions through the server to the
Bot's desktop. That desktop runs as a user with passwordless sudo and holds the
Bot's logged-in browser, so an Agent that can click on it could reach every Bot
display of the owner, the Bot computer's worker credential and its signing
keys.
