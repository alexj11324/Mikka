# Side thread navigation and Artifact entry

Web and Electron open the same chat at every width. The header carries the
thread title, navigation and applicable controls. 改动 and 验收 open from
更多. Back returns to the chat and restores its draft and reading position.

People open a delivered document from its named chip in the chat. The task
toolbar's Artifact button opens the task's plans, PRs, reports and captures.
Existing evidence links still open the referenced item. An independent
check awaiting its owner uses the shared reply composer.

This updates the Web and Electron behavior described in the
[November 15 thread decisions](2026-11-14-2330-capy-activity-and-thread-titles.md).

## Sidebar and history

Capy Desktop 0.9.2 uses a dedicated pane tab strip with ordered tabs and
context actions. Its chat reads recent events first, then retrieves older
pages as the reader approaches the top and keeps the visible message in place.

| Surface | Mikka behavior |
| --- | --- |
| Left navigation | Highlight the thread or task open in the work area. A Bot row gives priority to the waiting count or working state, with time as the idle state. Row actions appear where they are available. |
| Narrow work area | Keep short visible labels such as 验证 and 审阅. The tab's accessible name and the list of open tabs carry the full title. |
| Tab actions | Reorder by dragging or Alt plus an arrow. Open other close actions by right-click or Shift+F10. Save an edited task before closing it. On a failed save, show its tab and stop the batch. |
| Panel collapse | Keep the selected tab and its mounted contents. Return focus to the control that expands the panel. |
| Conversation history | Start with at most 500 combined message and event rows. Fetch older pages from the top, preserve the visible message, and append new events using the forward cursor. Compute the whole-history context estimate after showing the conversation. |

The sidebar uses Mikka's controls and tokens. The Web and desktop renderer
share the behavior.
