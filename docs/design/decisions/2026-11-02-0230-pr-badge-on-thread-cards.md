# Thread cards show their PRs as one badge

- Date: 2026-11-02
- Source: Alex, relayed by the coordinating session: a thread card should show
  which PRs its thread produced, in the style of Claude Code's web session
  list.
- Rule: R-66
- Confirmed: Alex approved the review page on 2026-11-02 with one change: an
  open PR reads 打开 (Open), as on GitHub, not 进行中. This is the shared
  `Metadata.prState.open` string, so the task page and the board read 打开 too.
- Replaces: R-66's PR chips (one chip per PR, extras folded into +N)

Every thread card (the chat's card under a reply, a bot's 概览 › 线程 and
全部线程) carries one PR badge on its right when its thread produced PRs.

- The badge is the summary state's git mark and the count. Summary state:
  any open PR makes it open (green pull-request mark); else any draft, draft
  (grey); else any merged, merged (purple merge mark); else closed (red). The
  colours are the GitHub tokens (`--github-pr-*`) in both themes.
- Hovering the badge opens a list of the PRs; on a phone, tapping it does.
  Each row is the PR's title (cut with an ellipsis), then its state mark,
  state word as GitHub names it (打开 / 草稿 / 已合并 / 已关闭; Open / Draft / Merged / Closed), repository and #number, and on
  the right the added lines in green and removed lines in red. A row opens
  the PR in a new tab. A click on the badge never opens the thread.
- A row shows line counts only when the server supplies them; the task's
  stored PR (url, state, title) has none yet.
- The board's task cards do not use the badge. They keep their PR item: the
  newest PR, coloured only by the state GitHub confirms for the current
  viewer (grey until it does), then +N. That a state is confirmed by GitHub
  for whoever is looking matters more than matching the thread cards, and the
  badge colours by the task's stored state (coordinating session, 2026-11-02).
