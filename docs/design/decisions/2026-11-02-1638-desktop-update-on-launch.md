# The desktop app installs a newer version before it opens

- Date: 2026-11-02
- Source: Alex, relayed by the coordinator: 电脑版启动时强制更新；用户把 App 关了，下次打开时如果有新版本，必须先更新完才能进入
- Rule: —
- Replaces: — (adds to `2026-10-31-2005-desktop-update-button.md`, which still holds while the app runs)

On a cold start the installed desktop app opens a small window that says
「正在检查更新」 before the main window. With a newer version it says
「正在更新到 vX」 with a progress bar, then installs and restarts into it;
there is no way in on the old version. A failed download says
「无法更新到 vX」 with the reason and 「重试」. No update, no network, or no
answer within 5 seconds: the app opens as usual, so a failed check never locks
anyone out. Closing the window quits the app.

While the app runs nothing changes: updates download in the background and the
rail's restart button offers them. The one exception is the server's minimum:
`/api/version` returns `minDesktopVersion` (ADR 0011's `MIN_CLIENT_VERSION`),
and a running app below it gets the same window before it can go on.
