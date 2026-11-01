# MVP API/CLI acceptance — 2026-11-01

All eight acceptance items passed. This continues [the earlier handoff](handoff-codex-to-cc-2026-11-01.md) and [PR #847](https://github.com/alexj11324/Mikka/pull/847). The results below establish isolated functional acceptance; production was not deployed.

## Fixed code and environment

- Final tested code: `494639ee1151901374f706eb2757630f95039f0c`, branch `codex/handoff-complete`. [CI run 41340466294](https://github.com/alexj11324/Mikka/actions/runs/41340466294) succeeded on this SHA; the PR had 31 successful checks and 6 conditional skips.
- Docker Cloud Sandbox `sbx_001m6c5tn3zv9chkwxem94h2ebh`, large: 8 vCPU / 16 GiB, Linux x86_64, Node 24.22.2, pnpm 10.34.3, PostgreSQL 17 with UTF-8 encoding. All interaction used CLI/HTTP.
- Application origin: `http://localhost:3110`. Database: loopback `mikka_loop_95822f132c40_e2e`; instance `1d5914f5-ea79-4c80-83a4-8979d845b54b`. Normal account-pool signup, sign-in and lease checks remained enabled.
- Application and source daemon stayed on `adb5e3e63e6ae40599a5b5928205fd6e65303edb`. Local items 1–7 ran from 18:40:08 to 18:45:12 UTC with fixed fingerprint `bdbe26066ed983f5e0f194c877569e869fc46c54196e87ce3157f75348f5a9da`.
- The cloud driver used `494639ee…`. Its only differences from the local artifact were the two daemon build scripts, their package test and `scripts/e2b/cloud-local-acceptance.mjs`. Application and daemon runtime source stayed identical. The original local manifests were verified, not rewritten.
- Cloud item 8 passed from 19:11:54 to 19:12:58 UTC. Private template `d2y3l8r3cpi7t06oh6x1`, build `3d7577d0-3ecc-4731-9b62-036deefba857`, was built from `6c3ce1a7e48a6c51fb54ea65d74d9eebb2598dac`. Its worker hash `688639aea944d70841a3f2968b540351f5bcc972` matches the final code's template inputs. Its private/ready state was read back from E2B.

## Results

| Item | Observed result |
| --- | --- |
| 1. Core loop | Real DeepSeek execution, file change, commit, push to a bare Git repository and PR receipt returned to Coordinator. GitHub's API was the isolated fixture. |
| 2. Read-only | Normal model task completed. Actual sandbox CLI push was rejected, remote refs stayed unchanged, and an identical writable control succeeded. |
| 3. Failure reason | A real repository fetch failure remained visible through the thread HTTP API, including its failed startup stage. |
| 4. Agent communication | Two Bots exchanged the requested messages through the normal API/model path. |
| 5. Inbox | Subscription persistence, owner isolation and removal passed. |
| 6. Native mailbox | Real tools, automatic wake, reply/ACK, duplicate suppression and foreign-owner denial passed. |
| 7. Worker mailbox | Device notification reached the running worker; inbox/read/reply/ACK and normal completion passed without a human reprompt or inbox polling. |
| 8. E2B cloud | Normal account → real model creates task → API dispatch → private template → worker registration/claim → real DeepSeek writes the file → `submit` → daemon verification → `succeeded`. |

Cloud run `376cbe90-04df-4dc7-9a1e-e38b03e64918` verified the exact generated marker and unchanged README. The signed policy issuer matched the restricted HTTPS relay, and the task branched from the fixture's declared default base commit. It used no workspace filesystem snapshot.

Local task creation-to-start times were 1.382, 2.237 and 0.937 seconds. Cloud E2B creation took 1.279 seconds; creation-to-first-model-event took 31.628 seconds. The latter includes model inference, fixture transport, the reverse relay and runtime startup; it does **not** demonstrate zero Mikka-added latency.

## Fixes and regression evidence

- Restored the missing claim-route module fixture: all five benchmark claim tests passed.
- Fixed bootstrap directory ownership for non-root execution and explicitly selected UTF-8. The old SQL_ASCII cluster reproduced a Chinese truncation error; a fresh cluster passed the same operation and the existing bootstrap test.
- Launched the relay with `/usr/bin/python3`, where the template installs `aiohttp`, and made all fixture-created worker directories owned by `mikka-runner`. Provider probes demonstrated each original failure and the corrected behavior.
- Shipped `capture-copy.mjs` beside the standalone MCP helper in both daemon distributions. The new package test first reproduced `ERR_MODULE_NOT_FOUND` in a registry-installed tarball, then passed initialization, tool listing and an actual `submit` handoff for both outputs. The existing packaged mock-daemon/real-Git test also passed.
- Configured a real fixture verification command. Positive output passed; wrong output and changed README were rejected. The cloud run then recorded passed daemon verification. The product's unverified-completion guard was retained.

The earlier Coordinator `Service Unavailable` did not recur on this Docker environment. Its historical cause was not established, and no retry or model fallback was added.

## Reproduction and cleanup

Use `scripts/dev/bootstrap-local.sh` on a fresh cloud Linux target. Supply the existing Infisical `dev:/vercel` DeepSeek key in process memory, remove unrelated ambient provider credentials from the test process, and run `scripts/dev-local/acceptance.mjs` with its normal Node imports. Items 1–7 used `LOCAL_LOOP_HOLD=1` and the existing cloud gates so the same server could serve item 8.

The separate cloud CLI invoked the existing `verifyCloud({ environment, runtime, apiKey, templateId, workerHash })` entry with the operator E2B key in memory. It validated the unchanged local source fingerprint and the exact reviewed driver delta before using the live descriptor. No CI variables, auth records or completion results were fabricated.

All test and diagnostic E2B VMs were killed. The owning driver stopped normally; active account leases, cloud machines and thread machines were all zero. Ports 3110/3191 were closed. Private account/session audit stores and the task's workspace sealing key were removed. The Docker sandbox was stopped, and the new private template was retained. Original production resources and the earlier paused acceptance machine were not used.

The exported evidence passed both account credential/Cookie scans and checks for the real DeepSeek/E2B key values and their URL/base64 forms. [The adjacent JSON](acceptance-mvp-cli-2026-11-01.json) records the receipts and evidence hashes.

No browser acceptance, real production GitHub PR, public template release, production merge or deployment was performed. A new run needs fresh bootstrap/accounts; stopped descriptors and removed credentials are not reusable acceptance evidence.
