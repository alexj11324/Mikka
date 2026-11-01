# GitHub plugin connection is separate from the login identity

- Date: 2026-11-01
- Source: Alex, MVP bug triage: 「我说是 GitHub App 可以连接到多个账号的，但是登录只能是一个邮箱登录一个账号，一个 GitHub 账号登录一个账户」
- Rule: —
- Replaces: —

Signing in stays one-to-one: one email is one Mikka account, and one GitHub
account signs in to one Mikka account. Better Auth's account linking is not
changed.

Plugins → GitHub → Link GitHub is a plugin connection, not a sign-in link. Any
number of Mikka accounts may connect the same GitHub account, and its email
does not have to match the Mikka account.

- The connection lives in `github_connections` (one row per Mikka user, no
  uniqueness on the GitHub id) with tokens sealed like Better Auth's. It never
  writes the `account` table.
- It uses the GitHub App's existing callback URL; the auth route takes a
  callback only when its state matches the connect cookie, so GitHub sign-in is
  untouched.
- Repository access and PR publication use the connection first, then a GitHub
  sign-in account linked earlier, so existing links keep working.
- Disconnect removes only that user's connection.
