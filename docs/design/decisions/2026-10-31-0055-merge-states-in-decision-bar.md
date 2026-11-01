# The merge states live in the decision bar

- Date: 2026-10-31
- Source: Alex, 「可以这样去做」 and 「我是觉得有点丑呀，你能够把它做好看一点吗？」
- Rule: R-40, R-74
- Replaces: a floating destructive Alert; an empty pane after merge; a check mark for 已合并

Laid out like Figma 06's bar. 无法合并 is the bar's title with a warning mark,
GitHub's reason is a warning chip beside 环境 and 提交, and 在 GitHub 打开 sits
next to 验收并合并 (no separate Alert in the pane). 合并中 is the title with a
spinner. 已合并 shows GitHub's merged PR mark (`PullRequestIcon` merged, as on
the candidate card) and keeps the candidate, criteria and results on screen.
The state chip reads 无法合并 too.
