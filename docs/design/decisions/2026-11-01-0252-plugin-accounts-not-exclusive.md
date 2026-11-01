# Plugin accounts are not exclusive to one Mikka account

- Date: 2026-11-01
- Source: Alex, MVP bug triage: 「GitHub 是可以连接多个账户的，你不应该把所有的账户都强绑定，所有的 plugin 都不应该强绑定给一个账户」「同一个GitHub可以连接到多个账号，而且不应该有这种约束」
- Rule: —
- Replaces: —

One external account (GitHub, Google) can be linked to any number of Mikka
accounts, and its email does not have to match the Mikka account's email.
Linking happens while signed in, so the user has proven both identities.

- Each Mikka account gets its own `account` row and its own tokens for the
  same `providerId`/`accountId`. Relinking updates only that user's row.
- Signing in with a shared GitHub (or Google) account lands on the Mikka
  account that linked it first (`account."createdAt"` ascending), the same
  order `linkedGitHubAccountId` uses. Use the account switcher to reach the
  others.
- Better Auth 1.7.12 hardcodes the opposite, so `patches/better-auth@1.7.12.patch`
  changes `linkOAuthAccount`, `findAccountByKey` and `findAccountOwnerByKey`.
  Recheck the patch on every Better Auth upgrade.
