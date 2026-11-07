# Ordinary interactions must not silently reload the page

- Date: 2026-11-07 (UTC; November 6 in Alex's timezone)
- Source: Alex's interaction-continuity request, tracked in #1603: “你可能点一下，整个 APP 就会进行一个刷新，这不正常吧？” and “把这些问题通通处理干净”.
- Rule: —; preserve the existing navigation, security and update requirements.
- Replaces: —; changes the removed-server-action recovery mechanism, not minimum-version enforcement.

## Requirement

Ordinary navigation and background responses must not discard the mounted
application, unsaved input or reading position through an unexplained hard
refresh. This does not authorize keeping data after sign-out or revocation,
or continuing to issue business requests from a known incompatible build.

## Implementation for missing actions

When a same-origin business response identifies a removed server action,
retire the old request stream and show the existing required-update prompt.
Do not automatically reload the page or replay the action. The person's
explicit Refresh action performs the reload. An update view mounting after
the response must observe the already-recorded requirement immediately.

An ordinary 404, a third-party response or the public version probe must not
activate the missing-action recovery path. Desktop minimum-version checks,
account/workspace isolation and existing version probes remain unchanged.

## Verification

Keep source-level regressions for silent reload prevention, obsolete-request
blocking, external responses, unavailable storage and late subscriptions.
They do not replace rendered application and production acceptance in #1603.
