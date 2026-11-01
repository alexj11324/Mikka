# Acceptance is the merge

- Date: 2026-10-30
- Source: Alex, #528 「我验收成功之后立刻 merge 啊，怎么还会有时间限制呢？」; the backend was handed to this session (「可以的，批准。这部分后端由你来接」)
- Rule: R-40, R-56
- Replaces: the `decisions.md` row 「Approving publishes at once」 (#494 「批准并发布」) and 「批准发布」 with 「1 小时内有效」

As in Warp Factories, a code candidate's acceptance tab has one action,
「验收并合并」. It merges the PR as the accepting person, with their own GitHub
identity, bound to the candidate sha. There is no approve, publish or deploy
step and no validity window (no 「X 小时内有效」 / 「有效至」). The states are
待你确认, 合并中 and 已合并; a refusal shows 「无法合并」 with GitHub's reason
and 「在 GitHub 打开」. A merge made on GitHub completes the task too. Preview
links are evidence only. Skills keep 启用.
