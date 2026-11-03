# Factory API/CLI acceptance — #1118

The selected Factory acceptance items **1, 2 and 3 passed** on fixed runtime
commit `2f07e6da05eef3c446e5caf5c11fa23aaaf27dc6`. That run needed no backend fixes;
the screenshot follow-up below added three UI corrections. This records the local acceptance in
[#1118](https://github.com/alexj11324/Mikka/issues/1118).

## Environment and version

- Branch: `factory/acceptance-flash-1118`, based on main including #1115 and #1117.
- Cloud Linux; Node 24.19.0; real PostgreSQL 17.11 and daemon from source.
- Run: `df305d4c-b9c2-4b25-9075-73d1247b261e`.
- Interval: 2026-11-03 11:52:52–12:01:36 UTC (06:52:52–07:01:36 America/New_York),
  including account/service cleanup. Final audits and database stop followed.
- Origin: `http://localhost:3110`; database `mikka_loop_df305d4cb9c2_e2e`,
  isolated on `127.0.0.1:5432` in owned container `mikka-factory-1118-db`.
- Existing configured Infisical workload identity; development model key read
  by the existing runner. Database password and auth secret generated in memory.
  Automatic owner/peer test accounts used normal application authentication.
- Source fingerprint before and after:
  `ef88a7620c6dece3488a678aa1fa59f9d8420920e83ea8eea5e988b614e746ce`.
  `source-evidence.json` records `fixedSource: true`; `passed-items.json` records
  `passedItems: [1,2,3]`. The command exited 0.
- Reused [CI 41629749259](https://github.com/alexj11324/Mikka/actions/runs/41629749259):
  source checks, core/integration units, daemon checks and all four PG17 shards
  succeeded. Its #1117 head `acd50462d7fea393c07c3de604e5c7aa367abf0d` and the
  tested main commit have identical tree `c7a1aa323d47f1229fd3ebea5faa21f95315070b`.

The new session initially reported offline/pending, then became connected/running.
The previous session's acceptance directory and `/tmp` driver/log were absent.
This is a new isolated run; it does not establish the old verify result or the
old environment's cleanup.

## Code candidate

Task `ca781f84-43a3-4ca2-87fd-782bde5876f4`; candidate
`4453cef5-2c63-444f-bfab-4639dec4c4d5`; SHA
`a44049f4a17447634d5adee56c430d5e45eae9a0`.

| Stage | Run | Independent CLI session | Result |
| --- | --- | --- | --- |
| execute | `9042790b-86d2-4448-bc4b-d12855147f62` | `1b5ce1d9-ba5c-4887-93bf-1b034d636eda` | passed |
| review | `f23879c9-b9ce-4adc-9aab-df19c44cb15e` | `856135ab-84bc-480b-97df-91b5d9cdbdac` | passed |
| verify | `25ba29fd-cec6-480f-8afd-968c971cc95a` | `78339c42-1229-4437-a4c9-a494715a1e58` | passed |

Ordinary Coordinator dispatch created the Factory task. The daemon really changed
README, committed and pushed to the local bare origin. The synthetic GitHub API
confirmed the PR, the remote tree contained the run marker, and the Coordinator
conversation exposed the PR URL. The host dispatched review and verify
automatically, both read-only and pinned to the candidate SHA.

Verify inferred `npm test` from the fixture's `package.json` script
`git diff --check origin/trunk HEAD`; the daemon receipt records exit 0, no timeout,
and the inference basis. The authenticated approval API returned the exact
candidate SHA. The PR was no longer draft. The task remains **approval/pending**
for the person's merge; acceptance did not merge the code candidate.

## Read-only report

Task `f7fdb93a-262b-440b-9650-ea44e1709ff4`; report candidate
`bd8e7962-137b-4c16-a988-e563ac60ffc7`; inspected SHA
`3914917de2906041d4039df1bbe15efd27ccc4d4`.

| Stage | Run | Independent CLI session | Result |
| --- | --- | --- | --- |
| execute | `53c91c8b-8be9-4b39-8b39-89d82e47d31e` | `ea2db3f2-b9cc-4604-822c-0d0e9c653657` | passed |
| review | `5d2f8ac9-35f6-4052-a375-cbdf175bb49d` | `8540ee5e-5ac2-48e6-8379-c01eb3fdc06c` | passed |
| verify | `7fb67aff-07b1-4f48-b6aa-277e1a00234e` | `fd62cc9c-5959-4b69-b519-ca34b8e73fbc` | passed |

The run was frozen read-only, pushed nothing, created no PR, and left remote refs
and PR count unchanged. Both checks produced host-owned read-only receipts for
the inspected SHA. This is report/evidence verification; its receipt correctly
records project verification command `not_run`.

The normal test account read the approval ledger and called the human acceptance
API with its current binding. The API returned `accepted`; a persisted
`factory_deliverable_acceptances` row binds the report candidate. Final task state
is **approval/passed**. No code merge was involved.

## Controlled repository failure

Task `cff20538-e698-4a52-9846-50685b065a96` began with run
`01e79bc9-49c6-459f-94c2-e8b537f5dd16`. Temporarily renaming only this run's bare
origin produced a real daemon Git fetch failure (exit 128). The authenticated
thread API retained the exact error and a failed `repository` startup stage.
The origin was restored in the harness's `finally` path.

The existing bounded retry loop also produced runs
`3418e698-13cb-469a-ab69-127a2a623a6a`,
`9901c39c-e70d-46c1-b43b-b7d11a3fe5a6` and
`589afa75-f725-49d1-8eb4-b4375da92b61`. All four failed at repository startup,
before a CLI session/model response. The task stopped at **execute/failed** with
its exhausted-budget reason. This expected failure is item 3's passing result.

## Model policy and cleanup

All **10 runs**, including fault retries, froze `deepseek-flash`; all 10 daemon
journal assignments matched. Each of the six successful CLI sessions recorded
assistant messages with exactly `deepseek-flash` and its matching session ID.
No Pro or other provider/model was selected. This records the provider's actual
Flash alias, without independently asserting its underlying version.

The preflight `node scripts/assert-test-model.mjs deepseek-flash` passed before
dispatch. The 15 model-policy, transport and key-seeding tests passed; rejected
Pro requests recorded zero upstream calls.

All runs are terminal. The runner revoked its device token, removed its temporary
daemon credential files and stopped its application, fixture service and daemon.
Ports 3110/3191 are closed. Lease `1b7432c7-6079-4591-89c4-b11226013ad5` ended at
12:01:36 UTC and is `quarantined`, as the runner deliberately releases retained
fixture environments with outcome `dirty`. It is no longer active. The owned
PG container was then stopped; its database and evidence were retained.

Local private evidence is under
`.cache/dev-local/acceptance-df305d4cb9c24b25/`: `environment-summary.json`,
`source-evidence.json`, `passed-items.json`, redacted `services.log`,
`factory-audit.json`, `model-audit.json` and `final-checks.json`. Raw account,
credential and CLI transcript files are not copied into this report.

This proves the selected local API/CLI Factory flow with real model, daemon,
PostgreSQL and local Git. GitHub API behavior is synthetic. It does not establish
real E2B, production OAuth, browser UI, production merge, or items 4–8 acceptance.
No browser tests, production database writes or main pushes were performed.

## Real UI follow-up requested by Alex

Alex required screenshots of the actual acceptance process and the human UI,
then identified the separated commit icon, duplicate footer SHA and incorrect
environment label in those screenshots. Changes are on the same handoff branch,
without a PR or main push:

- `8efe8924931702577322fb206def409d3a5ef87d`: one compact copyable commit label;
  removed the repeated candidate SHA from the action bar. Browser geometry
  confirms a 4px icon/text gap, one candidate copy control and zero footer copies.
- `cc9b2c4e`: actual runtime environment/machine name instead of the approval
  fallback; keep accepted reports reachable and read the persisted task state.
  The real UI accept had returned HTTP 200/accepted while the prior view still
  displayed pending. Three added regressions failed before the fix and pass now.

The repeat owned environment is
`.cache/dev-local/acceptance-f656a8c50c844a4d`, run
`f656a8c5-0c84-4a4d-ae4f-c2c77ab1cb87`, database
`mikka_loop_f656a8c50c84_e2e`, PG17.11 in `mikka-factory-1118-final-db`, same
loopback origin and automatic test-account mechanism. Fixed model execution was
on `8efe8924`; its selected item 1 passed and recorded fixed-source evidence.
The runner's fingerprint covers its enumerated runtime paths, not components;
the clean Git revision and component hashes additionally identify the UI.

Code task `5f74a62f-be1e-43d1-91e5-f903beb4218b`, candidate
`d01cd65f-a70e-4605-90bc-235b89d9f986`, SHA
`aac66e8928cb24214ea22949e7020a7f3eb155e1`:

| Stage | Run | Session | Result |
| --- | --- | --- | --- |
| execute | `8ab0c13e-f8cb-48f3-8f31-e929c66dad49` | `98eee8f4-b6ad-4995-9d5b-b2bf4a589710` | passed |
| review | `5c8de65c-32d6-4584-afd6-9afa4f7e030c` | `068337c2-3323-43ed-a019-3ced25082d56` | passed |
| verify | `0fd4561f-2412-497f-8221-d0b76b3c9c14` | `203cb733-a7b3-4e4a-930f-7b2d50117880` | passed |

The real pane displays 4/4 criteria, independent results and the human merge
button. This synthetic code PR remains pending the person's merge.

Report task `c108e2c6-d461-4244-960e-9b970d482e9b`, candidate
`4c07c637-366a-4ffb-8825-08716836bfec`, inspected SHA
`f23c2eaee169dc1cdf97c725cad12e783fafd90c`:

| Stage | Run | Session | Result |
| --- | --- | --- | --- |
| execute | `d4e393da-dbc0-4a13-868f-735cfa982806` | `0fa09756-ae6f-4757-a3d2-64c78c7169d2` | passed |
| review | `5c2aeeb3-b5e4-4347-b4c7-b2eb0bf6e7b2` | `e72592e6-1709-490f-be9f-7a1c7f767519` | passed |
| verify | `95e6dcce-a38c-41cd-aade-7f23785b0d4c` | `e594797c-d654-4c9d-99de-15c613f3755c` | passed |

The report request was entered into the real Coordinator composer. Initial run
`fa4f93c4-7045-41a0-b9f2-1a26e8604fc8` failed with `Server unreachable` at startup;
the host's existing bounded repair dispatched the successful execute above.
This failure is retained. All seven frozen runs/journal assignments and all six
successful root CLI sessions used `deepseek-flash`. The two nested CLI Agent
transcripts also record only `deepseek-flash`.

At **12:30:01 UTC / 07:30:01 America/New_York**, the real report UI's 验收 button
sent its bound accept operation and returned HTTP 200 with `status: accepted`.
The persisted acceptance row binds that candidate. The UI initially remained
pending, demonstrating the state bug. All model runs were terminal before the
subsequent view-only corrections; the corrected UI reloaded the same retained
data and now shows **已验收**, 5/5 criteria and actual machine name
`579a43969c3c`. No record was fabricated or rewritten to produce the screenshot.

Screenshot gallery: `/tmp/factory-1118-ui/index.html`. Key original browser
captures are `07-fixed-code-execution.png`, `11-review-evidence-open.png`,
`12-report-before-accept.png`, `14-report-accepted-fixed.png` and
`15-final-environment-and-commit.png`; the bound UI response is recorded in
`ui-acceptance-receipt.json`. Images are actual 1600×1000 Chromium captures of
the isolated **development** application, not production-build design approval.
Browser control tools were not callable; the existing cloud Chromium was used
through a temporary capture script. No browser test suite was run. Final page
captures had no page/console errors; an earlier accept captured a development
React `useInsertionEffect` warning, retained with that earlier capture.

Validation on the final UI: 54 component/state/evidence checks, typecheck,
UI/interaction policy, i18n and targeted oxlint all passed. Earlier stale
generated Next route types were retained under `/tmp`, then regenerated; no
application type was suppressed. Main remains untouched; coordinator integration
and Alex's visual review are still pending.

Cleanup: all seven runs terminal; device token revoked; lease
`3e3eca62-1d63-4376-bbff-7de893acb73d` ended/quarantined at 12:38:30 UTC. Owned
application/fixture/daemon stopped, ports 3110/3191 closed, temporary daemon
credentials removed. The final PG container was stopped with its data/evidence
retained. Earlier isolated containers were also stopped and retained.
