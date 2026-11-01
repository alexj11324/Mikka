# Focus never re-reads data

- Date: 2026-11-01
- Source: Alex, on the GitHub plugin page flashing on every screenshot or window switch: 「每次进这个窗口，他都要重新查一次这个情况。这是绝对禁止的行为，严查」
- Rule: —
- Replaces: —

On web, the desktop shell and mobile, nothing is read again because a window
or page gets focus, becomes visible, or the app comes back to the foreground,
and nothing on screen is hidden or replaced by a loading state for that
reason.

Data stays current through:

- loading when a page or component mounts;
- re-reading after the person's own action (`mutate`);
- pushes and subscriptions;
- polling that already exists (`refreshInterval` and timers). Keep it; do not
  add polling to make up for focus.

A flow that finishes somewhere else (OAuth in the system browser from the
desktop shell, Start in Telegram, installing the GitHub App) uses an explicit
signal: the callback URL parameter on a fresh page, or one check armed by the
hand-off itself (`useCheckOnReturn` in `lib/hooks/use-check-on-return.ts`).
Plain focus never arms it. The 刷新 GitHub 状态 and Telegram 刷新状态 buttons
stay deleted (`../decisions.md`, 插件 page IA, 2026-10-31): those pages now
re-read on the hand-off's return, not on focus.

Enforced by `scripts/focus-refetch-policy.mjs` (`pnpm test:ui-policy`): SWR's
`revalidateOnFocus` is off site-wide (`components/swr-defaults.tsx`) and may
only be `false`; `refetchOnWindowFocus` and `focusManager` are out; a
`focus`, `visibilitychange`, `pageshow` or `AppState` `change` listener is
allowed only in a file on the policy's allowlist, with its reason (animation,
read-receipt flush, push token, OTA prefetch, polling pause).
