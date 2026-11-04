# Question recovery command source — real local UI evidence

Application commit: `7486013ae8c0cb2570e348db380cec46102a6271` (PR #1250 / issue #1237).

Captured on 2026-11-04 from 18:18:29.075Z to 18:18:44.833Z in the authorized Docker Cloud Sandbox. The exact application commit completed a production Next.js build with Node 24.22.2, pnpm 10.34.3 and PostgreSQL 17.11. This evidence commit adds documentation and images only.

## What was checked

The screenshot driver used the normal TestAccountPool registration/login flow against an isolated local PostgreSQL database, then opened the production build at `http://localhost:3400`. It did not intercept API responses, run a browser test suite, call a model, or access production data.

The actual task-detail route returned HTTP 200 to the fixture owner and HTTP 404 to the separate peer. Both independent checks returned the persisted source execution ID, session ID, stopped status, recovery event ID and observation time. The original review verdict remained **failed** and the independent verify verdict remained **passed**.

The images show the source label and locale-formatted observation time in Chinese and English, at 1440×960 and 390×844, in light and dark themes. All nine images were visually inspected: source text wraps within the narrow layout, result badges retain their meanings, and the source button opens the recorded pre-question execution. The navigation image shows the fixture marker from that source run.

## Captures

| Locale | Size | Theme | Image |
| --- | --- | --- | --- |
| Chinese | 1440×960 | Light | [zh-source-1440-light.png](zh-source-1440-light.png) |
| Chinese | 1440×960 | Dark | [zh-source-1440-dark.png](zh-source-1440-dark.png) |
| Chinese | 390×844 | Light | [zh-source-390-light.png](zh-source-390-light.png) |
| Chinese | 390×844 | Dark | [zh-source-390-dark.png](zh-source-390-dark.png) |
| English | 1440×960 | Light | [en-source-1440-light.png](en-source-1440-light.png) |
| English | 1440×960 | Dark | [en-source-1440-dark.png](en-source-1440-dark.png) |
| English | 390×844 | Light | [en-source-390-light.png](en-source-390-light.png) |
| English | 390×844 | Dark | [en-source-390-dark.png](en-source-390-dark.png) |
| Source navigation | 390×844 | Dark | [en-source-thread-390-dark.png](en-source-thread-390-dark.png) |

[manifest.json](manifest.json) records the exact commit, environment ID, fixture IDs, observation times, actual route statuses and each PNG SHA-256.

## Reproduction and scope

- [capture.mjs](capture.mjs), SHA-256 `967cf79a51c614e0b1acccb3e8505871386f33430c12ab62747383d22e57a905`.
- [runtime.mjs](runtime.mjs), SHA-256 `e15578188addeff5f3dca5649deb1ce65d1009bc8e04f470e5911f52e1742776`.
- Environment: `local-530f4b3a-690c-4e30-9a69-5d656ca4d242`, isolated database `mikka_source_7486013a_e2e`.
- Local fixture accounts were quarantined dirty after capture. No test data was inserted into production.

These are **synthetic, persisted local fixtures**, clearly labelled in the UI. They validate the real server read and UI projection of the metadata, not native execution or the admission of historical command provenance. The separate PostgreSQL regressions in PR #1250 cover that admission boundary. No production acceptance is claimed by these screenshots.
