# A write the Decisions API cannot judge goes ahead, logged

- Date: 2026-11-01
- Source: Alex, relayed by the coordinator session: when the Decision API cannot be reached, a write no longer asks the person for approval; it is bypassed, or left to the model running the task.
- Rule: R-77
- Replaces: "an unavailable, refused or malformed judgment asks" in the 2026-10-31 app-write row of `../decisions.md` (#657), and its "a `readOnlyHint` tool skips the call"
- Superseded by: [2026-11-10-1730-workspace-app-permissions](2026-11-10-1730-workspace-app-permissions.md) (app access is a workspace level; there is no per-action write judge or per-person allow/ask/deny).

> Historical body: superseded by [2026-11-10-1730](2026-11-10-1730-workspace-app-permissions.md). The current code still reads per-person allow/ask/deny and calls this judge; the target contract is workspace app access only.

The Decisions API judges every app write and read the person's settings leave
open, the `readOnlyHint` tool included (the hint is input). When it gives no
answer (unavailable, refused, malformed), no card is shown: the agent running
the task already judged the call by making it, so it goes ahead, and the log
records `Write judgment fallback`. Unreadable settings name nothing and leave
the call to the judge. The person's explicit allow, ask and deny still win
first.
