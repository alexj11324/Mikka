# Mobile self-hosting acceptance

Scope: #1568, using the public discovery contract from #1556 and the realtime
gateway from #1561. This checklist separates executable logic checks from Expo
Web visuals and installed iOS behavior.

## Automated checks

Run from the repository root:

```sh
pnpm test:mobile
pnpm test:mobile-push
pnpm --filter @mikka/mobile typecheck
pnpm --filter @mikka/mobile export:web
```

`server-discovery.test.mts` checks HTTPS/loopback rules, root-to-base-path
fallback, missing mobile trust, version/protocol refusals, legacy servers,
timeouts and bounded JSON. `server-store.test.mts` checks persisted account
isolation, equal user IDs across servers, same-server cookie namespaces,
durable writes, corrupt state and notification routing. `server-api.test.mts`
holds a cookie read across an account switch and verifies the old request and
its follow-up remain on the old server. `server-transport.test.mts` uses a
real local HTTP server to verify that auth cookies cannot follow redirects.
`server-push.test.mts` holds token creation and a registration response across
switching and checks old-server cleanup and the next account's registration.

For the optional #1567 cloud model integration, `chat-failure.test.mts` and
`failed-reply.test.mts` cover all cloud error codes, native model recovery,
on-demand billing and duplicate taps. `model-menu-view.test.mts` distinguishes
cloud credits, the operator's provider and older servers. `web-open.test.mts`
checks the billing destination, no local credential forwarding, and discarding
late replies after an account or workspace switch.

## Expo Web screenshots

Use the production Expo Web export with a disposable discovery/session fixture,
or an isolated test server. Label fixture screenshots as fixtures: they prove
layout and copy, not an actual authentication, model reply or push delivery.
Capture every row at **375, 393 and 430 pt**, in **light and dark**:

| State | Action and expected view |
| --- | --- |
| Initial login | Mikka Cloud is visible above the existing sign-in methods |
| Choose server | 更改 opens the shared segmented picker and self-hosted address field |
| Probe succeeds | Show the returned name/revision and 继续, without a login request yet |
| Unreachable | Connect to a deliberately closed local fixture port; show 连不上这台服务器 |
| Incompatible server | Discovery with `desktopProtocol.max: 0`; show the server-update line |
| Mobile not enabled | Discovery with `mobileReady: false`; show 请在服务器上允许 Mikka iOS |
| Self-hosted login | Continue to the selected name/revision and its configured providers |
| Saved accounts | Two fixture accounts with different servers and one current checkmark |
| Cloud model | The existing model menu shows Mikka Cloud 额度; the collapsed chip remains Mikka 默认 |
| Cloud quota exhausted | The existing failed-reply area shows the shared cloud error and 去 Mikka Cloud 充值 |

At implementation time the Expo production export and logic suites ran in the
development container. Screenshot execution was blocked: the Browser plugin
had no originating extension context, and the cloud browser could not reach
that container's local preview; its URL policy then refused the error-page
observation. No screenshots or native-device results are claimed by that run.
The matrix remains a release acceptance item until a connected preview browser
or a published preview is available.

## TestFlight checklist

Record the exact source commit, API image/revision, installed app version/build,
EAS update ID/channel/runtime and iPhone/iOS version before checking these items.
Use two disposable accounts, one on Mikka Cloud and one on the self-hosted
installation. Use a second self-hosted account to verify same-server isolation.

- [ ] On a fresh install, the default is Mikka Cloud. Open 更改, choose
  自托管服务器, type an HTTPS URL with the keyboard, and connect. The expected
  name/revision appears; cancelling keeps the original server.
- [ ] Probe a server without `mikka://` trust and see the mobile-specific error.
  Enable that exact trusted origin, restart the server, and retry successfully.
- [ ] Sign in with email on the self-hosted server. If Google or GitHub is
  configured, complete its own-provider browser flow and return to this account
  in the app. Unconfigured providers do not appear.
- [ ] Open a bot chat, send a message and receive its reply through the selected
  server. Start a thread and see new messages without reopening it; no hosted
  realtime service is needed for the built-in gateway.
- [ ] With `models` authorized, open the native model menu and see the cloud
  credit label. A refusal about cloud permissions uses this same native picker;
  it does not open model settings in a browser.
- [ ] Exhaust a disposable test allowance and tap 去 Mikka Cloud 充值. The page
  belongs to the configured cloud service and the cloud principal's billing
  workspace, not the phone's local workspace. Cancel back to the same chat.
  No billing request runs before the tap, and a revoked cloud connection does
  not sign out the self-hosted account.
- [ ] Hold the billing response, then switch accounts or workspaces before it
  completes. No page for the previous identity opens.
- [ ] Open 设置 → 账号与服务器, add the Mikka Cloud account, then switch between
  both. Each screen shows that account's own chats and workspace, including when
  server-side user or bot IDs happen to match. Neither login is repeated merely
  because the other account was selected.
- [ ] Add a second account on the same self-hosted server. Switch and sign out
  that account; the first account remains signed in and keeps its workspace.
- [ ] Force-close and reopen the app with the self-hosted account active. The
  same server/account/workspace returns before any default-server session fetch.
- [ ] Start a large attachment upload or browser handoff, then switch accounts.
  Any old operation stays bound to its original server; no attachment, cookie
  or handoff token is sent to the newly selected installation.
- [ ] With the push relay configured, register notifications, switch accounts,
  and send a test push to each. Foreground presentation and tap navigation only
  accept the selected server/account. Check cold-start taps as well. Repeat with
  the old server offline and record OS background behavior separately from the
  app's routing filter; offline remote unregistration is best effort.
- [ ] Use VoiceOver to read the server name, address, inline error, account rows
  and current selection. Check large Dynamic Type, the URL keyboard, scrolling
  on small screens and Reduce Motion. Expo Web does not verify these behaviors.
- [ ] Switch to self-hosting and receive a compatible official Expo update. The
  official update channel/runtime is unchanged, and the active account remains
  selected after restart.

No new native package, app scheme, permission or signing configuration is added
by this change. An OTA still requires a matching installed native fingerprint;
successful export or publication alone does not prove installed-device support.
