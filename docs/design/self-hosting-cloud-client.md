# Self-hosted cloud connection settings

- **Status:** in review
- **GitHub:** #1564; API contract in `docs/cloud-services-api.md`
- **Owner thread:** self-hosting implementation

## What the user does

An administrator registers this server and optionally supplies a team key.
Each person can connect their own Mikka account and choose services. Each
connection shows whether it is active and which credits apply.

## Where it lives

Community installations add Settings › Mikka Cloud for explicitly configured
server administrators, and Settings › Account › Mikka Cloud for each person.
The cloud's own consent and connected-server management pages are private.
Cloud edition keeps its current navigation.

## Layout and states

Use the current settings rows and spacing. Loading uses `SettingsLoading`;
errors use `FieldError`; unregistered personal accounts show an unavailable
connect control and the administrator state. Normal rows show connection and
billing source. Revoked personal authorization offers reconnect, without
silently selecting the team key. Writes disable their controls while pending.
Dark mode and narrow windows use the same existing responsive primitives.

## Components and rules

`SettingsSection`, `SettingRow`, `Button`, `Input`, `Label`, `Checkbox`,
`FieldError` and the existing settings sidebar. No new visual primitives.
R-40 (no subtitles or filler), R-90 (reuse), S-P (server authority) and S-O
(visible save failures) apply. Navigation and error copy live in both message
dictionaries. No polling, focus refresh or background token-refresh timer.

## Copy

Mikka 云 / Mikka Cloud; 个人账号 / Personal account; 服务器 / Server;
已连接 / Connected; 未连接 / Not connected; 授权已撤销 / Authorization revoked;
连接 Mikka 账号 / Connect Mikka account; 服务器密钥 / Server key;
我的 Mikka 额度 / My Mikka credits; 团队 Mikka 额度 / Team Mikka credits.

## Done when

The API/DB cases prove callback ownership, one-time state, encrypted storage,
cross-replica refresh, scope refusal and revocation. Review light/dark 1440px
screenshots of the production build and complete a real nonproduction server
binding and revocation before marking #1564 accepted. Tests that skip without
PostgreSQL are not acceptance evidence.
