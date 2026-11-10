# Chat reply actions and the waiting sentence

- Date: 2026-11-10 20:02 UTC
- Status: accepted
- Supersedes in part: [2026-11-03-0455-chat-quote-and-copy](2026-11-03-0455-chat-quote-and-copy.md) (reply action visibility)

## Context

Two chat-chrome problems were reported on 2026-11-10:

1. A reply's 复制 and 「N 个来源」 row appeared only while the reply was hovered. On a wide chat the bare icons read as a stray mark that appears and disappears, and a touch screen has no hover at all. Codex keeps the same actions under every message at a quiet contrast; the user asked for that, without a floating toolbar.
2. A run's question was stored as an event line in the transcript (`runQuestion`), centred and muted, with the thread as a link-coloured title. It accumulated one line per question and read like a rendering defect. The thread's own card already names the run and its badge already says 等待你.

## Decision

**A. Reply actions are always there.** 复制 and 「N 个来源」 sit in one row under every stored reply; reactions follow right after them. The icons stay muted; hover or focus raises contrast. No container, border, shadow or floating toolbar is added, and nothing appears or disappears as the pointer moves. The issue-thread panel keeps `HOVER_ACTIONS` for its messages, the person's and the Agent's; a reply in the Coordinator chat uses the persistent row.

**B. A question is a live state, not a message.** `runQuestion` is no longer drawn as a transcript event line. While a task still waits on the person, the composer column shows one sentence above the input: a question icon in the warning colour, an ICU-plural count, and the thread that has waited longest as an inline link inside the sentence (its task's title when it has one). The thread is never a row of its own, and two threads of one task count once.

Whether it still waits follows `localTaskState` and the inbox: a closed task, a newer active attempt, quota, a merged pull request, a failed run, or a task waiting for review (in review, or with an open/draft pull request) is not an answer the person owes; a live `waiting_input`, a judged `needs_input`, or a run that ended `asked_human` before the judge answers is. A thread with no task shows only its live wait: it has no continuation the person could start, so an ended question there would never clear. The stored event never carries a title and the asking run usually ends as `stopped` (the judge may also mark a `succeeded` run `needs_input`), so the sentence reads the task's **newest** run (the same `issue.run` the inbox reads): an answered question starts a continuation run on the same task, whose newer state removes the sentence. A source that has not loaded yet waits for the next chat read instead of showing model text.

This does not change [2026-11-10-0659](2026-11-10-0659-task-code-chips-and-work-area-tabs.md): a thread named in a sentence is its title in the link colour, with no icon, chip fill, accent or state badge.

## Consequences

- The thread card's 等待你 badge stays the per-thread state; the sentence answers "what is waiting on me now" in one place instead of accumulating history.
- The sentence only links the oldest waiting thread; a count tells the person there are more. A future extension may list up to three rows, but that requires a product decision, not a layout change.
- Tests move from the event-line spec to the waiting-strip spec: a pure projection (`lib/coordinator/waiting-questions.ts`), the composer-row assertions, and one Playwright line asserting that no `data-event-line="runQuestion"` row exists.

## Alternatives rejected

- A floating, bordered action toolbar over the reply (Capy's shape): the user asked for Codex's persistent row, and a floating bar implies a selection toolbar.
- Keeping the question in the transcript and restyling it: the transcript is history; a live state rendered as history accumulates and cannot be dismissed or replaced.
