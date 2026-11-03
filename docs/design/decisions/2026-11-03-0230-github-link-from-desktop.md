# Link GitHub from the desktop links the app's account

- Date: 2026-11-03
- Source: Alex hit both bugs on Plugins → GitHub, relayed by the coordinator session: the link went to the Mikka account signed in to the system browser instead of the one in the desktop app, with nothing on screen; and back in the app the page kept showing 关联 GitHub with no way to refresh. 「连接必须落到发起这次连接的那个账号上」; 两者不一致时明确提示「浏览器登录的是 X，App 里是 Y」并给切换入口; 连接进行中窗口重新获得焦点或可见时重新拉取状态。
- Rule: —
- Partly replaces: [2026-11-01-0400](2026-11-01-0400-no-refetch-on-focus.md) as to the GitHub link hand-off (one check on return)

**The account.** The desktop app takes a one-time token naming its own account
(ten minutes, single use, stored as a hash) and opens the GitHub start in the
system browser with it. The browser starts GitHub only when its own session is
that account. Otherwise nothing is linked and the token stays usable:

- the browser's GitHub page says 「浏览器登录的是 <its account>，App 里是
  <the app's, masked>」 with 切换账号, which signs the browser out and back in
  and returns to the same link (继续关联 GitHub);
- the app says the same with both addresses and 在浏览器中打开.

A browser that is not signed in signs in first and comes back to the same link.
The token alone links nothing and tells anyone but the two accounts nothing.

**Coming back.** While a link started in the app is unfinished (up to the
token's ten minutes), every return to the window (focus, or the page becoming
visible) reads the GitHub status again, at most once a second; once linked it
shows at once and the reads stop (`useChecksUntilDone`,
`lib/hooks/use-check-on-return.ts`). Plain focus still never reads, nothing
polls, and other hand-offs keep their one check.
