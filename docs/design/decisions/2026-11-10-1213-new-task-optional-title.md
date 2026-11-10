# The New task window has an optional title the person writes

- Date: 2026-11-10
- Source: Alex, looking at the 新建任务 window with only a description box: 「这里可以加上 title，允许自建吧，看看 capy 怎么做的」.
- Rule: R-22
- Superseded in part by: [2026-11-10-1341](2026-11-10-1341-sidebar-short-title-limits.md): the typed full title remains exact, but the derived short title and compact sidebar label obey the shared 12-character / 6-word limit.
- Replaces: R-22's 「describes the task in a sentence and the Coordinator writes it」 as the only way to name a task.

## How Capy does it

A Capy issue has a required title and an optional description (`POST /api/v1/issues`). A thread's title is generated from the first message in 50 characters or fewer; Rename fixes a title by hand, Regenerate title turns auto-titling back on, and a thread can also be created with a `title`.

## What Mikka does

- The window has a single-line title above the description. It is optional, at most 60 characters (what a task's short title holds), one line.
- A title the person types is the task's title exactly. The Coordinator is told it, and the host uses it when the task is created even if the model passes another title. The same text is the task's short title, so lists show it as typed and the short-title job leaves it alone. A replay of the same request cannot rename the task.
- With no title, nothing changes: the Coordinator writes the title from the description.
- A title alone is enough to send; the description is then the title. A description alone is enough as before.
- The title travels as the structured `taskTitle` beside `profileId` and the destination, stored on the person's own user event, so a model's text cannot set it.
