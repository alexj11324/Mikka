# #1161: Smoke Cloud → independent device feasibility

Assessment: 2026-11-04 06:44 UTC. Result: **blocked before execution**. No production request, login, pairing, task, model call, provider operation, or authorization change was performed for this assessment.

## What the existing evidence establishes

The [normal Smoke inventory](https://github.com/alexj11324/Mikka/blob/c91704bee984829b9d736679cd078bf470a6260a/.github/pr-evidence/production-1157-1163/runtime-capabilities-41756726830.json) completed at 01:50:21 UTC with GitHub connected=false, installed=false and repositoryCount=0. This is a historical observation; no new account query was made. It does not establish that every present configuration is unchanged.

Ordinary new dispatch in [steps.ts](https://github.com/alexj11324/Mikka/blob/aee3b8d23fc1431b4c0f6c98d9852d1402bc723e/workflows/coordinator/steps.ts) calls withResolvedRepository. [repository-resolution.ts](https://github.com/alexj11324/Mikka/blob/aee3b8d23fc1431b4c0f6c98d9852d1402bc723e/lib/coordinator/repository-resolution.ts) checks a GitHub owner/repo or full public URL against the owner's live authorized list. [user-access.ts](https://github.com/alexj11324/Mikka/blob/aee3b8d23fc1431b4c0f6c98d9852d1402bc723e/lib/github/user-access.ts) derives that list from the owner's GitHub user credential and current Mikka App installation intersection. There is no public-GitHub anonymous exception in this path.

A different public remote does not meet the recovery contract: [queue-run.ts](https://github.com/alexj11324/Mikka/blob/aee3b8d23fc1431b4c0f6c98d9852d1402bc723e/lib/computer/queue-run.ts) creates the Cloud repository receipt only for writable v2/github.com repositories, and [run-leases.ts](https://github.com/alexj11324/Mikka/blob/aee3b8d23fc1431b4c0f6c98d9852d1402bc723e/lib/run-leases.ts) requires that receipt together with host-frozen allowLocalRecovery and a Factory attempt before Cloud → local takeover. Lower-level admission helpers are not independent owner dispatch endpoints.

The formal [device login](https://github.com/alexj11324/Mikka/blob/aee3b8d23fc1431b4c0f6c98d9852d1402bc723e/packages/daemon/src/login.ts) and [registration](https://github.com/alexj11324/Mikka/blob/aee3b8d23fc1431b4c0f6c98d9852d1402bc723e/app/v1/devices/register/route.ts) paths can normally pair a new independent runner to Smoke. That registration does not grant access to a GitHub repository. Primary's already authorized device belongs to another owner and was not used.

## Scope and next gate

A complete substitute requires normal owner evidence of an **already authorized exact repository** before any Cloud task or new runner is started. No GitHub/OAuth grant, sharing change, SQL-created device, or alternative-host workaround was performed or proposed as a bypass. If the repository gate is satisfied later, use a dedicated bounded driver with exact new-device/token cleanup; do not reuse the disposable local acceptance driver's account-wide cleanup or remove its CI checks.

Only after normal owner GET confirms a new exact Task/current epoch/run may the separately approved single-task READ ONLY diagnostic inspect the host grant, checkpoint and machine generation. Prepared helpers at cae49588c9a641ac14bf0d61591bb108845178d6 are inactive and remain proof-incomplete; no process fault was armed.

Source was read at b8397cc55d4e0d14c4ba3e5566476a703d6fd731 and compared through aee3b8d23fc1431b4c0f6c98d9852d1402bc723e; the relevant files did not change. This report does **not** claim real Cloud → device acceptance, device → Cloud acceptance, or completion of every #1161 acceptance criterion. The separately passed local offline handoff and online 45-minute watchdog evidence retain their original, narrower scopes.
