# Desktop updates download in the background; the rail offers the restart

- Date: 2026-10-31
- Source: Alex in chat: 「我们现在 APP 是不是缺一个预缓存机制呀？比如有更新的话，我们提前缓存好，然后设置一个按钮（比如是一个圈，下面带个下载的 icon），点一下就可以更新…我看 Codex 就是这样的，他就喜欢放在左边这一块，就是头像的上边」; 「不要过度设计」
- Rule: —
- Replaces: the desktop's two update dialogs (download? / restart?)

The desktop app checks for an update at launch and every four hours and
downloads it without asking. Nothing shows while it is available or
downloading. Once it has downloaded, the icon rail shows one button directly
above the account avatar: lucide `CircleArrowDown`, the rail's own item style,
tooltip and label 「重启以更新到 vX.Y.Z」, a short fade-in. A click quits and
installs; quitting the app any other way installs it too. The web app never
shows the button. The macOS menu's "Check for Updates…" still answers with a
native message.
