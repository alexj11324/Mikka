# Community settings visual evidence

Retired from CI on 2026-11-08: there is one UI and no separate open-source look
to screenshot ([decision](../../docs/design/decisions/2026-11-08-2133-one-ui.md)).
The `community-settings-ui.yml` workflow was removed; these scripts are kept.

This is a production-component screenshot entry, not a product route or a
browser functional test. It uses the existing production Vite configuration,
fonts and tokens to render `SettingsView` inside `AppFrame` with its settings
palette. The actual `SettingsSidebar`, Preferences controls and resizable pane
render unchanged. The application rail and window bar are omitted; this is not
a capture of a signed-in application shell. No product component is recreated.

The independent GitHub job serves the build on a runner-local origin and
answers only synthetic GETs for the workspace and issue prefix. The edition
comes from the workspace response, so `SettingsView` owns Billing visibility.
The community views begin with the real settings resolver's `billing` initial
section and record what the component renders after that response. They do not
exercise or claim an authenticated URL redirect. The cloud views begin with
Preferences. Both use a synthetic shared workspace with an admin role.

Four screenshots cover community/cloud in Chinese, light/dark, at 1440 × 1000.
There are no clicks, form submissions, real sessions, database or provider
credentials. The capture rejects writes and external browser requests, keeps
Chromium's sandbox and refuses to run outside GitHub Actions. It is not a
fallback around the blocked local browser environment.

The evidence follows `scripts/self-hosting-ui`'s publication format without
depending on that newer cloud/mobile entry. The build manifest records exact
source commit, lockfile hash, actual imported modules and asset hashes. The
capture manifest records origin, requested initial section, rendered heading,
selected sidebar item, Billing-item count and the GETs observed for each PNG.
These are review observations, not assertions of business-flow acceptance.
`reviewed` starts false. The owner must inspect every original PNG against
`docs/review-checklist.md` and attach the immutable evidence reference to the PR.

Only same-repository pull requests publish. A job-scoped `contents: write`
token creates a new `evidence/community-settings-ui/<head>-<run>-<attempt>`
branch and independent root commit containing only the four PNGs, manifests,
README and HTML gallery. The publisher refuses an existing ref and never
updates the source branch, `main` or existing evidence. It uploads no duplicate
Actions artifact, adds no workflow to the evidence commit and prints fixed
commit links in the job summary. No OAuth, billing, save, redirect or runtime
acceptance is claimed by this job.
