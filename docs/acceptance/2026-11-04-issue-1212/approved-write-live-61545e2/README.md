# Approved-write live acceptance — 61545e2

This evidence belongs only to application commit `61545e2cfc9cd90e445a442c2762cb5ccfe6b4f1`, tree `0202b368f84c17184523903c4f4adc1e3debb3e7`, PR #1269. Its parents are `ab3c9d986cd670079adca040471daf33fe8009cd` and main `eb0c5cb65ad9b8991a2b27d21105a0093f06aac5`. The real Git integration preserved both branches; package.json had a text conflict with no semantic key conflict. All 23 changed-file blobs were checked against the Vercel worktree tree and the GitHub tree.

## Actual local execution

The authorized replacement Vercel Sandbox ran Node 24.22.1, pnpm 10.34.3 and PostgreSQL 17.11. The runtime used a fresh loopback `mikka_approved_61545e2_e2e` database, full tracked migrations, a normal TestAccountPool signup/signin, and an actual production build. A generated password was assigned to the local database role and supplied only through the process environment; no real model/provider credentials were used. The local `/mikka/api/version` was verified against the exact application SHA before capture.

| Gate | Result |
| --- | --- |
| Exact-head GitHub Actions | 23 jobs complete: 18 success, 5 conditional skips |
| approved-write unit and React/SWR | 96/96, no skips |
| actual parent Coordinator component | 19/19, no skips |
| full live PostgreSQL suite | 27/27, no skips |
| typecheck / lint:code / diff check | pass |
| production build / normal TestPool capture | exit 0 / 24 PNG files |
| captured browser errors / local HTTP failures | 0 / 0 |
| known credential and cookie evidence scan | passed |

CI: [full suite](https://github.com/alexj11324/Mikka/actions/runs/41924201845), [Browser gate](https://github.com/alexj11324/Mikka/actions/runs/41924201904), [Device gateway](https://github.com/alexj11324/Mikka/actions/runs/41924201951), [Analytics SSR](https://github.com/alexj11324/Mikka/actions/runs/41924201992).

The capture ran from 2026-11-04T22:29:17.609Z to 22:29:40.824Z. The manifest records all 24 image hashes and the environment identity. Every downloaded PNG was checked against that manifest. The complete transfer archive was 1,099,665 bytes, SHA-256 `c933915958e168f6e6710501224d04cbe8f535a0db7d4aafe5aa83ce553ed9d1`.

## What the pictures show

There are three actual approval-service display states: pending, uncertain after the local provider accepts beforeSend and reports an unknown outcome, and expired. Each appears in English and Chinese, at 1440×960 and 390×844, in light and dark mode. The provider fixture does not perform an external effect. Browser automation is used only for normal navigation and screenshots, with no request interception or browser test runner.

The implementation reviewer inspected all 24 original images through six contact sheets made without resizing the screenshots. The cards and composer do not overlap; long target UUIDs wrap in the narrow viewport. Pending cards have approval and decline controls. Uncertain cards show an unconfirmed result with no resend control. Expired cards disable approval and retain decline. Synthetic bilingual message and proposal content are deliberately identical across locales; surrounding interface text follows the selected language. Independent visual review is tracked in the PR discussion.

The runtime removed only the journaled local proposal/ledger/message IDs and quarantined the leased test account pair. The manifest records cleanup. No production records were created.

## Expiry observation regression

The shared deadline protocol was verified before this final main integration and its source blobs are unchanged in this commit. A conservative request-start deadline can read early. If a real later HTTP response still reports positive remaining server time for the same expiry, the client must arrange the final authoritative read without reopening the subscription, ticket or socket. A new finite observation may rearm a fired timer; cached data, rerenders, older responses and server-expired responses may not. While a timer remains active, new observations never postpone it.

On the actual old `ab3c9d9` production modules, two new channel cases and the real pending-list React case failed for the missing second/final read. The approved-card slow-response React case already passed on that old implementation and is retained as compatibility coverage, not claimed as a failing-before case. After the fix, the frozen channel/cache suite was 34/34 and the approved suite was 96/96. The final exact-head CI also ran the common channel and actual Worker gates successfully.

Earlier screenshots on `95a2636` and checks on `ab3c9d9` remain historical records and are not used as these final screenshots. An initial local parent-component test command referenced the wrong file path; it was corrected to the actual existing component file and the unchanged 19 assertions passed. The original failure was not reclassified as a product result.

## Remaining acceptance

This is local build, transaction, protocol and display evidence. It is not production traffic acceptance, a fixed-task one-hour comparison, or proof of a healthy production WebSocket. PR #1269 stays draft. Production merge must be coordinated with the existing gateway Worker release supporting the new live kinds, followed by the GitHub Web deploy result, exact public build pin, real production acceptance and the issue body's measurement gates.

## Screenshot index

| State | EN desktop | EN narrow | ZH desktop | ZH narrow |
| --- | --- | --- | --- | --- |
| pending | [light](images/en-pending-1440-light.png) / [dark](images/en-pending-1440-dark.png) | [light](images/en-pending-390-light.png) / [dark](images/en-pending-390-dark.png) | [light](images/zh-pending-1440-light.png) / [dark](images/zh-pending-1440-dark.png) | [light](images/zh-pending-390-light.png) / [dark](images/zh-pending-390-dark.png) |
| uncertain | [light](images/en-uncertain-1440-light.png) / [dark](images/en-uncertain-1440-dark.png) | [light](images/en-uncertain-390-light.png) / [dark](images/en-uncertain-390-dark.png) | [light](images/zh-uncertain-1440-light.png) / [dark](images/zh-uncertain-1440-dark.png) | [light](images/zh-uncertain-390-light.png) / [dark](images/zh-uncertain-390-dark.png) |
| expired | [light](images/en-expired-1440-light.png) / [dark](images/en-expired-1440-dark.png) | [light](images/en-expired-390-light.png) / [dark](images/en-expired-390-dark.png) | [light](images/zh-expired-1440-light.png) / [dark](images/zh-expired-1440-dark.png) | [light](images/zh-expired-390-light.png) / [dark](images/zh-expired-390-dark.png) |
