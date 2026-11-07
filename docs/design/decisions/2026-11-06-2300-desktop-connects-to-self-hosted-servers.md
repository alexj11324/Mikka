# The desktop app connects to Mikka Cloud or a self-hosted server

- Date: 2026-11-06
- Source: Alex, 2026-11-06, in issues #1556 and #1557: 「同一个官方桌面 App，既能连 Mikka 云，也能连用户自己部署的服务器」, following LobeHub's desktop. 「官方 App 连接任何服务器都用 App 自带的界面，暂定这样」.
- Rule: —
- Replaces: —

One official desktop app talks to Mikka Cloud (the default) or to a server the
person runs. The sign-in page names the server below the sign-in card, with
更改 to choose 「Mikka Cloud」 or 「自托管服务器」 and an address. The app reads
the address's discovery endpoint (#1556) once before accepting it, and says
which of these went wrong: the address is invalid or not HTTPS, the server
cannot be reached, it is not a Mikka server, the server is too old, or the app
is too old. The built-in server is named 「Mikka Cloud」 in both languages,
the untranslated brand (`scripts/copy-policy.mjs`), where the issue wrote
「Mikka 云」.

Each signed-in account remembers its own server, and accounts on different
servers stay signed in together. The account switcher names each account's
server only when the accounts are on more than one. Settings › 账户 › 服务器
shows the current server with 切换 (sign in on another server as another
account) and 断开 (sign out every account on that server).

The app keeps its own bundled interface on every server. Showing the
community interface when connected to a self-hosted server would be a separate
decision.

How it is enforced: an account's credential is sent only to the exact origin
and base path that answered the probe, never followed through a redirect, and
plain HTTP is accepted only for this computer (`127.0.0.1`, `localhost`).
