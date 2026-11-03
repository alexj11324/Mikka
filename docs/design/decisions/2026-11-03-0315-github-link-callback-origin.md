# The GitHub link answers its own origin

- Date: 2026-11-03
- Source: Alex, through the coordinator session: 「关联回调不走代理 hub，用发起关联时所在的 origin……预览域名不在 App 登记列表里时，要明确报错，不要静默落到生产。」
- Rule: —
- Replaces: —

Plugins → GitHub sends GitHub the origin the link started on as its
`redirect_uri`, never the sign-in proxy hub (`BETTER_AUTH_OAUTH_PROXY_URL`).
The proxy relays sign-in only. A link started on a preview whose callback went
to the hub reached production, with a state only the preview's database holds.

A preview that should link GitHub needs its exact callback,
`https://<preview origin>/mikka/api/auth/callback/github`, registered on the
GitHub App, with a stable `BETTER_AUTH_URL` (the branch URL) set for that
branch. An origin the App has not registered stops on GitHub's own
`redirect_uri` error page; nothing reaches production. Production's origin is
the hub, so production is unchanged.
