# Link GitHub from the desktop: the app's account, back through its loopback

- Date: 2026-11-03
- Source: the coordinator session, confirmed point by point: follow RFC 8252 for the desktop app; authorize in the system browser; bind the link to the account signed in to the app, not the browser's Mikka session; return to the app automatically; (a) a loopback, no custom URL scheme; (b) the answer waits until the return reaches this computer and the app sends a verifier only it holds; (c) an older desktop keeps the browser-session check with an update hint, no forced update; (d) PKCE where GitHub supports it, checked against GitHub's documentation.
- Rule: —
- Partly replaces: [2026-11-03-0230](2026-11-03-0230-github-link-from-desktop.md) for desktop builds that have the loopback return

A desktop build with `prepareReturn` starts Link GitHub by opening a one-shot
listener on `http://127.0.0.1:<port>/return` and asking the server for a
one-time link with that address, a state for the listener, and S256 of a
verifier it keeps. The system browser goes straight to GitHub whoever it is
signed in as, or with no Mikka session at all. The server runs PKCE with
GitHub (`code_challenge_method=S256`; GitHub's documentation for GitHub App
user access tokens lists it as strongly recommended and does not support
`plain`). GitHub's answer is kept sealed on the link; the browser is sent to
the app's loopback, which shows one line (已连接，可以回到 Mikka。) and brings
the app forward. The app then sends its verifier and the answer becomes the
connection of the account signed in to the app. A link opened on another
computer returns to that computer's 127.0.0.1, never reaches this app, and
links nothing. Each link is single use and lives ten minutes.

An older desktop build keeps 2026-11-03-0230: the browser must be signed in as
the app's account, both sides say when it is not, and both add 更新桌面版可以一步完成.
Every return to the window still reads the status again while a link is in
progress.
