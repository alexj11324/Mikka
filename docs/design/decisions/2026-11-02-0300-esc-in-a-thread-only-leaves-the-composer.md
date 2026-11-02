# Esc in a thread only leaves the composer

- Date: 2026-11-02
- Source: decision K2, relayed by the coordinator session after an HCI walk-through:
  in a thread's composer Esc only leaves the box and never stops the thread;
  stopping is the button. A bot chat keeps its behaviour.
- Rule: R-10 (the thread composer's keys)
- Replaces: —

- In an open thread (`IssueThreadPanel`, wherever it opens) Esc takes focus out
  of the composer. It never stops the thread, even while it runs; the stop
  button does.
- A bot chat, the Coordinator's and a group chat keep Esc as stop while a reply
  can be stopped.
- The shared `ChatComposer` carries this as `escapeStops` (on by default; the
  thread panel turns it off), so there is still one composer.
