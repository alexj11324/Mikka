# Factory candidate commit label

- Date: 2026-11-03
- Source: Alex, reviewing the actual Factory acceptance screenshot in #1118:
  “那个不是有个两条线中间一个圆吗？跟后边的那个 hash 怎么隔这么远啊？而且还出现两个 hash 值”
- Rule: —
- Replaces: the separated commit icon/hash and repeated candidate hash in the
  current acceptance pane.

Keep the commit icon directly beside the short hash in the candidate card as one
copyable control. Show the current candidate hash there once; the bottom action
bar does not repeat it. Independent review/verify rows retain their own checked
SHA, and an invalidated approval may still identify its superseded commit.

Alex also requires evidence of the real acceptance UI and its process, including
screenshots of the actual task, independent results and the human acceptance
interaction. API/CLI success by itself does not satisfy this UI evidence request.
