# Focus is stale-while-revalidate, never a re-query

- Date: 2026-11-01
- Source: Alex, on the GitHub plugin page flashing on every screenshot or window switch: 「每次进这个窗口，他都要重新查一次这个情况。这是绝对禁止的行为，严查」; refined the same day to follow what Linear, Slack, GitHub and Figma do
- Rule: —
- Replaces: —

On web, the desktop shell and mobile, coming back to a window, tab or app
never hides, flashes or replaces what is on screen with a loading state or
skeleton, and never re-queries data that is still fresh.

- **Stale-while-revalidate on focus.** The site's SWR defaults
  (`components/swr-defaults.tsx`, in the root layout) revalidate a key on
  focus only when its data is older than the freshness threshold
  (`focusThrottleInterval`, 60 s by default; a hook may set it longer). The
  age counts from the last answer, so a poll or a `mutate` keeps data fresh.
  The revalidation runs in the background; the screen keeps the data it shows
  and only changed parts update. Hooks do not set `revalidateOnFocus: true`
  themselves.
- **Polling only while visible.** Existing polling (`refreshInterval`, timers)
  pauses while the page is hidden (`refreshWhenHidden: false`) and catches up
  through the rule above. No new polling.
- **Push first.** Where data arrives by push or streaming (chat history,
  thread messages), push is the main path and focus does not reload it
  (`revalidateOnFocus: false` on those hooks). A reconnect would fetch only
  what arrived since; no such cursor exists yet, so none is added here.
  Immutable content (rendered citations, images, diagrams, versioned artifact
  text, the archived chat) and the open issue's editor load are off too.
- **Third-party connection status never on focus.** GitHub, Google, Linear,
  Telegram and Composio status is read on page entry, after the person's own
  action, and on an explicit completion signal: the OAuth callback's URL
  parameter on a fresh page, or one check armed by the hand-off itself
  (`useCheckOnReturn` in `lib/hooks/use-check-on-return.ts`, for the desktop
  shell's system browser, Telegram's Start and the GitHub App install). Plain
  focus never arms it. The 刷新 GitHub 状态 and Telegram 刷新状态 buttons stay
  deleted (`../decisions.md`, 插件 page IA, 2026-10-31).
- **Mobile.** `useApi` returning to the foreground revalidates once, silently,
  only when its data is older than 60 s, and resumes polling.

Enforced by `scripts/focus-refetch-policy.mjs` (`pnpm test:ui-policy`): no
hook-level `revalidateOnFocus: true`, no `refreshWhenHidden: true`, no
`refetchOnWindowFocus` or `focusManager`, `revalidateOnFocus: false` on every
SWR hook in the third-party status files, and a `focus`, `visibilitychange`,
`pageshow` or `AppState` `change` listener only in a file on the allowlist
with its reason (animation, read-receipt flush, push token, OTA prefetch, the
gated `useApi` return, the hand-off check).
