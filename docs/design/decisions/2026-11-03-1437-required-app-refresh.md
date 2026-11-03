# Require refresh for stale web builds

- Date: 2026-11-03
- Source: Alex, Neon traffic investigation: 「能不能推送强制更新，暂停旧 APP 的使用，然后弹出一个弹窗，让他们强制更新可以吗？」; then 「继续」. Alex also explicitly authorized merging and publishing necessary fixes after verification.
- Rule: —
- Partly replaces: [2026-11-01-0400](2026-11-01-0400-no-refetch-on-focus.md), solely for the public build-metadata probe below

A web build checks the stable public `/api/version` once a minute, sharing
its existing cache with navigation and explicit-action checks. This endpoint
reads build metadata, not database rows or third-party connection status.
When a different build is known, pause application fetches and SWR reads and
show a blocking update dialog with one refresh action. Unknown versions and
network failures do not block the page. Keep the page mounted and preserve
persisted chat drafts until the person refreshes. The routine version-mismatch check never silently
reloads; the existing removed-server-action recovery remains unchanged.
The existing minimum desktop-binary update path remains separate.

This code only runs after a client has loaded it. It cannot add a popup to a
previously loaded build retroactively. Do not delete old deployments or claim
all old clients updated merely because this guard deployed. Track the old
server-action traffic separately and verify the initial migration.

Alex subsequently asked 「把vercel的旧版本停了不就行了吗？」 and clarified
that production must use the owned domain. On 2026-11-03 at 14:44 UTC, the
pre-optimization Skew Protection threshold was advanced to 13:28:42 UTC.
Verified old deployment headers and query IDs on `app.aspectlylabs.com` then
resolve to the current production build. This retires old routing through the
official domain without deleting rollback artifacts. Vercel's automatically
generated deployment URLs are infrastructure identifiers, not a new product
entry point; no evidence showed the user opened one.
