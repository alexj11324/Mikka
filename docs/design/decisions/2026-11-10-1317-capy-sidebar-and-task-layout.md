# Capy-style Bot navigation and task detail order

- Date: 2026-11-10
- Source: Alex, reviewing the new #1865 / hosted #66 UI with a Capy screenshot: 「左边 sidebar 那里，BOT 的图标是没有的，群聊的图标也是没有的」 and 「BOT 下面是可以折叠的，折叠展开之后，BOT 和 Agent 都在这下面。我觉得这个方法很好，你可以去做一下」. After the right task view's repeated title, property-card-first order and cramped body were identified, Alex confirmed: 「你的观察是对的，就这样的继续处理吧」.
- Rule: R-01, R-82; glossary and component map.
- Replaces: the hosted sidebar restriction to Bot/group rows without children; the work-area task implementation that put a large property card before the title and repeated the title in an inner toolbar. The task-list model in [2026-11-07-2045](2026-11-07-2045-tasks-only-threads-inside.md) continues outside this navigation exception.

## Sidebar

A Bot is the parent row, with its existing avatar and an independent expand
button. Expanding it reveals its dispatched tasks and Agent work, named for
the work. It does not create separate global Bot and Agent lists. Group chats
also retain their existing avatar. Existing new-Bot, new-group and management
routes remain available.

Task children carry the task's own state icon (`localTaskState`), and the
executing Agent can be identified by its existing brand/Profile mark. Opening
a child uses the existing task or Agent-conversation work-area navigation.
Each workspace remembers its own Bot expansion state.

Use the existing authorized live task/run lists and the selected workspace's
Bot roster. Runs are owner-wide, so a run enters the tree only through a
dispatching Bot in that roster. A legacy run with no Bot cannot be attributed
to a workspace here; its existing task/list entry remains available. The
tree does not fetch private prompts, enumerate other people's Bots or add
polling. Workspace changes must not retain another workspace's children.

## Right task view

The work-area tab names the task. Inside it, start with one large editable
task title and the code/time. Follow these with compact property rows, then
description, subtasks and activity, as in the Capy reference. Remove the
repeated inner title bar and the large property card ahead of the title.
Keep save, more and expand-to-page actions available.

This decision changes the hosted layout and navigation, not Bot/Agent
execution ownership, authorization or the task's chronological conversation.
Acceptance uses screenshots of the combined new public/private build.
