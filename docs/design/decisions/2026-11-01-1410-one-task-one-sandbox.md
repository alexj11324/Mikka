# One task, one cloud sandbox, paused between its runs

- Date: 2026-11-01
- Source: Alex, in the MVP acceptance session: 「E2B 是一次任务完成之后就不再使用的，但相关文件还是要存储，避免后续可能还会再开 follow up。任务跟沙箱机器应该是强绑定。不能一个任务用完之后，另外一个任务接着去用，这是不允许的。」 and 「免费和暂停能保留多久就保留多久，如果收费就不保留。」
- Rule: —
- Replaces: one new sandbox per run, killed when the run ends

A task's cloud runs share one E2B sandbox. The task's first run starts it
from the workspace snapshot. When a run of an open task ends, the sandbox is
paused, not killed, and the task's next run resumes it: the worktree, the
agent's sessions and the worker are still there. A sandbox is only ever
resumed for the task, bot and repository it was started for, and never while
the run that holds it is still active; no other task can be given it.

Pausing is the only way a sandbox is kept, because it is free and unlimited:
"Paused and killed sandboxes are not billed."
(https://docs.e2b.dev/faq/calculate-sandbox-price) and "A paused sandbox is
kept indefinitely. There is no time-to-live and no automatic deletion."
(https://docs.e2b.dev/sandbox/persistence). A paused sandbox resumes any
number of times; checked on 2026-11-01 with three pause/resume cycles on one
sandbox, files and processes intact, resume in about 0.2 s. Per-task
snapshots are not used: E2B documents no price or retention for them.

When the task is done, canceled, a duplicate or deleted, its paused sandbox
is killed and its device retired (the run-recovery sweep). If E2B no longer
has the sandbox, the task's next run starts a new one from the workspace
snapshot and continues from the task's branch.

Being schedulable and being recoverable are separate. The device row only
decides whether a machine can be dispatched to and whether it appears in any
list: a task's sandbox device never appears in a list or a picker and is
never dispatched to another task, paused or not. The `thread_machines` rows
(task → sandbox, with its state) are kept for good: the task finds its own
paused sandbox through them and resumes it. Only when the task is closed,
a duplicate or deleted is the sandbox killed; its rows stay as history.
