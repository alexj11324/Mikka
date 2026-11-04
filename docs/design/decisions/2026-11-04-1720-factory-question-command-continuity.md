# Command evidence across a Factory question

- Date: 2026-11-04
- Source: Alex, [#1237](https://github.com/alexj11324/Mikka/issues/1237) and [the 17:20 decision](https://github.com/alexj11324/Mikka/issues/1210#issuecomment-6637112423): “把有恢复回执严格绑定的前一段命令算作这次执行的证据，并堵上绕过修复次数上限的那条路。”
- Rule: —
- Replaces: The checker prompt's prohibition on using the receipt-bound predecessor's commands to satisfy the producer's execution requirements.

Answering a question and resuming the task continues the same execution. A
host-written, immutable question receipt must bind the direct predecessor to
the task, original attempt, question and answer, owner, request epoch and
session. An ordinary answer now writes that receipt in the answer transaction;
the existing recovery receipt remains authoritative for a failed continuation.
Sharing a session ID alone never establishes this relationship.

The independent review or verification may use successful command observations
from that direct predecessor. It still inspects the current fixed candidate
and compares the earlier file and Git observations with that candidate. Missing,
ambiguous, truncated or oversized command collections cannot establish a pass.
This does not change the predecessor's failed or stopped status, its timestamps,
or any previous check result.

When a result cites an admitted predecessor command, the acceptance result shows
“来自提问前的执行” (“From the execution before the question”), its observation
time, and the existing secondary action to view that source run. The host freezes
the admitted provenance with the independent check; a report cannot create a
source by naming an arbitrary run. Unrelated results keep their current layout.

The same receipt establishes execution continuity for the repair budget. A
question continuation is not a new repair attempt. Ordinary retry and repair
entry points all enforce the existing three-repair limit; a request ID, reason
string or caller-provided flag cannot exempt a new repair. A new Owner request
keeps the existing separate request epoch.
