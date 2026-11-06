# Desktop sign-in returns to the app

- Date: 2026-11-06
- Source: Alex's report relayed by the coordinator: signing in with Google from the macOS app bounced between the app and the browser and ended in the browser. Production logs for 18:59–19:02 UTC showed both exchanges succeeded; the app never came to the front, the browser handed over its web session without showing it, and the sign-in page waited for a second Google click.
- Rule: —
- Partly replaces: [2026-11-03-0300](2026-11-03-0300-github-link-loopback.md) (a) "no custom URL scheme", for the sign-in return only

The loopback and PKCE exchange stay the only channel that carries a sign-in
code. The callback page on `127.0.0.1` then opens the app's own link,
`mikka-auth://auth/done?id=<random>` (`mikka-dev-auth` for Mikka Dev), so
macOS brings the app to the front, which the app cannot do itself since
macOS 14. The link carries nothing else; the app accepts only an id it handed
out in the last ten minutes, and ignores every other path or parameter. The
page then tries to close itself and otherwise shows 已登录，可以关闭此页 with an
打开 Mikka button. The scheme is declared in the packaged Info.plist and is
not the internal `mikka://app/…` renderer scheme.

When the app asks for Google or GitHub, the browser page starts that provider
at once. When the browser already has a web session, the page shows that
account first (以 <名字> 继续 / 换个账号); 换个账号 opens the provider's account
picker. Slack, Linear and Figma desktop sign-in work the same way.

ASWebAuthenticationSession (a system sign-in sheet over the app) was
evaluated and is not shipped yet: it needs a native module built and signed
with the app, which this change could not build or verify; the PR records
where it stopped.
