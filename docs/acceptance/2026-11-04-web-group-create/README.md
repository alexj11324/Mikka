# PR #1239 — Web group creation

Application commit: `56bffda106d9a521eb7f8d36e1da57c104dff1b2`.

## Environment and scope

Large Docker Cloud Sandbox; local production `pnpm build` / `next start`, Node 24.22.2, pnpm 10.34.3, PostgreSQL 17.11. The immutable TestAccountPool descriptor binds this commit, the isolated `mikka_group_56bffda1_e2e` database and `http://localhost:3300`. The owner and peer signed in through the normal application account helper. No browser test suite, API interception, production data or paid model call was used.

The `manifest.json` records exact timestamps, synthetic fixture IDs, observed HTTP results, focus return and SHA-256 hashes. `capture.mjs` is the actual driver. Its screenshots wait for fonts and finite UI transitions to finish; the UI's animations remain enabled.

## Verified behavior

- Eight ready-dialog views: Chinese/English × 1440/390 px × light/dark, with two selected owner Bots and a long unselected Bot name.
- One normal browser POST created a group (201). Independent PostgreSQL read confirmed exactly those two Bots and the Owner; normal Owner GET returned 200, peer GET returned 404. There were no group turns and no model messages.
- Actual API requests attempting to add another owner's Bot or a Bot in another workspace both returned 404 and created no group.
- On cancel, focus returned to New on desktop and the sidebar toggle on mobile in both languages/themes. The created group opened in the existing chat surface; the final two images show desktop and phone.
- The deferred POST/workspace-unmount DOM regression failed on the old code, then passed with the lifetime guard. Repeated submit while pending produced one POST. `pnpm test:groups`: 22 passed; typecheck, lint, i18n and production build passed on this application tree.
- GitHub CI workflow 41876498182 plus Browser gate 41876498269, E2B official instance runtime 41876498194, E2B subscription custody 41876498210 and Analytics SSR 41876498386 completed successfully. The optional OIDC job was skipped by its existing condition.

## Diagnosis retained

Earlier capture setup errors were diagnosed without changing the application or test-account guards: fixture IDs must be reserved before insertion; workspace switching must finish its normal server-action navigation; the phone uses its existing sidebar-toggle label. The corresponding dirty account leases and local fixtures remain quarantined. An earlier image set captured a checkbox during its color transition; the final driver waits for real animations to finish. Its original images remain in the local `screenshots-1740` checkpoint and were not relabeled as the final run.

This evidence proves the local UI and permissions flow. Production group-policy and Factory model acceptance follows the main merge, Web deploy success and exact production version confirmation; it is not claimed here.
