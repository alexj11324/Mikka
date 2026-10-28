# Connect a computer and approve daemon login

- **Status:** in review; new frames require Alex's acceptance.
- **GitHub:** #357, MVP item 4.
- **Figma:** existing accepted style guide `98:2`; [device dialog and code confirmation review](https://www.figma.com/design/zPe5LKycb2XuT1ivCLRw07?node-id=347-4758), frames `347:4761`, `347:4798`, `347:4835`, `347:4873`, `347:4890`, `347:4907`, `347:4916`, `349:4879`, `349:4894`, `349:4909`, `349:4916` are pending Alex's acceptance.
- **Owner thread:** `codex/mvp-device-auth`.

## What the user does

Install the published daemon, sign in through the existing Mikka login, then run
it on their computer. In the browser, compare the code with the terminal and
approve or deny that connection.

## Where it lives

Settings › 设备 › 连接电脑 opens the command dialog. The daemon prints a link to
`<origin><basePath>/device?user_code=...`. Signed-out users return to that exact
page after the existing sign-in flow. No new login provider or method is added.
The Settings button, its keyboard shortcut and reconnect action all use this
same dialog. Directly connected Linux computers are 本机 too; the operating
system is not evidence that a computer is an SSH target. The old SSH setup
dialog is no longer the Settings entry point.

## Layout and states

Reuse the existing dialog, buttons, code block, input and authentication page
components with the accepted Mikka neutral tokens and Geist typography. The
dialog has three ordered commands, each copyable; no subtitle or SSH form.
Use the current origin and base path in Preview commands. The production
default can omit `--server`.

The approval page shows the signed-in account, terminal code and approve/deny
actions. Cover code entry, review, loading, approved, denied, expired/invalid
and request failure states, in light/dark and a narrow viewport. There is no
automatic approval on page load.

## Rules that apply

R-05, R-23, R-24, R-30–R-35, R-40, R-42, R-43. No execution-identity management
screen or native Coordinator runtime is introduced.

## Protocol and data

Better Auth 1.7.12's deviceAuthorization plugin accepts only `DAEMON_CLIENT_ID`.
An appended, repeatable migration creates its `deviceCode` table. After the
approved token grant creates a temporary session, the server revokes that
session and returns a newly minted `device_tokens` credential. The approving
browser session is preserved. The daemon rejects a normal web-session token.
Device-code pages and endpoints are not cached and suppress referrers.

## Packaging and release

`pnpm --filter @mikka/daemon build` emits JavaScript, protocol code and runtime
assets into `packages/daemon/dist`. The generated package contains no `tsx` or
workspace dependency. The source package is private; the distribution is not.
The isolated pack test exercises the compiled CLI outside the workspace with
only its declared external dependencies, including manual `--token` login.

The public package name and manual npm trusted-publishing workflow are
**待 Alex 确认** in `decisions.md`; no release has been executed. Configure the
approved npm package's trusted publisher for this repository and workflow
before dispatching it. Production variables: `MIKKA_BASE_PATH` and
`MIKKA_DAEMON_PACKAGE_NAME` at release build time; existing auth/database
variables remain in Infisical. `NEXT_PUBLIC_MIKKA_DAEMON_PACKAGE_NAME` must match
the approved published name in the web build. No new long-lived npm token is required by the
proposed workflow.

## Verification and remaining gates

Better Auth integration fixtures cover an unknown client, Preview base path,
pending/approved/denied/expired grants, owner binding, exactly one exchange and
session cleanup. Existing daemon HTTP login tests verify polling and reject
unexchanged session tokens. Command tests cover the exact Preview origin and
base path. Packaging tests use the packed artifact, not the TypeScript entry.

Actual PostgreSQL bootstrap/replay runs only in isolated GitHub CI. Before this
item can ship, the UI review, green PR CI, published npm package and fixed-SHA
Preview browser-login acceptance still need their own evidence.
