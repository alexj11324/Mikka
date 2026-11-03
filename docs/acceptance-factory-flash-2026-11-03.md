# Factory API/CLI acceptance — #1118

The selected Factory acceptance items **1, 2 and 3 passed** on fixed runtime
commit `2f07e6da05eef3c446e5caf5c11fa23aaaf27dc6`. No product source changes were
needed. This completes the remaining local acceptance in
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
