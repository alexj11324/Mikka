# The one task entry is named 任务; 看板 and 列表 are its views

- Date: 2026-11-17
- Source: Alex, 2026-11-17, on a Desktop build whose sidebar listed both 任务 and 看板: 「只留一个 task 嘛，看板跟 list 都属于 task 里面的一个部分」, 「这里我是绝对不允许有两个一级入口的……不管是看板还是 list，都只是显示这个 tasks 的一个 view 而已」.
- Refines: [2026-11-13-1405](2026-11-13-1405-one-task-status.md) § One entry, which kept one item but named it 看板.

## Decision

- The navigation has exactly one item for tasks, named **任务** (`Nav.tasks`), on every client. There is never a second top-level item for the board, the list or any other task view.
- 看板 and 列表 are views inside 任务, switched on the page. The page's path reads 任务 / 看板 or 任务 / 列表 after the view that is showing.
- An old `?section=tasks` link still opens 任务 in its list view.
