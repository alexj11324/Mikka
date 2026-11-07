# Issue 1512: fixed 1f548 sequential SQL diagnostic

This is a prepared, isolated HTTP/PostgreSQL diagnostic. Preparation starts no API, database, gateway, browser, model, daemon or VM. The owner must review and publish the frozen operations files before the single diagnostic job runs.

## Why this measurement is needed

The actual macOS report for Desktop run `42368835389` records Native login **196** SQL calls versus Web **173**. Native phases are **19 authentication + 16 PKCE/automatic renderer + 161 workspace**, versus Web **19 + 0 + 154**. The first startup pair is **172 bundled / 187 hosted**. These remain the full-window measurements; this diagnostic cannot replace them or turn them into a pass.

`lib/request-log.ts` records request/action start and completion, route, status and duration, but no SQL count. The original `db-metrics.cjs` records whole-process query counts and PostgreSQL connection bytes. `lifecycle-query-counts.mjs` keeps RPC action counts for only `/api/rpc` and `/api/desktop/rpc`. It filters out REST routes. The private API stdout file lives under `.cache/desktop-runtime`, while the workflow uploads audited `.cache/desktop-evidence` and `.cache/desktop-native-evidence`. The archived 1f report therefore cannot reconstruct the missing REST/query attribution after the runner has gone away. Sampled APM/db_sample data would not prove an exact unsampled count either.

This diagnostic measures normal requests separately on the same compiled source. It does **not** multiply their costs by RPC counts to claim an exact decomposition of the earlier concurrent 16/161 windows. Concurrent work and any intervening SQL remain included in their measured request windows or explicit gaps.

## Exact identities

| Object | Expected value |
| --- | --- |
| PR head | `1f548a73304923da466ebe702c99b6a8f6096f15` |
| PR head tree | `3635e075173ffb83c1e157a7f5a93296d2697603` |
| Actual compiled/synthetic source | `7355553d3ec5e3c99b792f27eda2c8380724eeb2` |
| Actual compiled tree | `de1e82157c2e64a55607e7655073ecff884c56ba` |
| Source parents, in order | `f7225f3eb1e38762dfdecde0395792c85b81ec22`, PR head above |
| Successful Desktop run / attempt | `42368835389` / `1` |
| Linux API artifact | `13572179042` |
| ZIP bytes / SHA-256 | `47871680` / `33b411a43819c5ad08ff47c69a6283aa697898cb18fce2e79ac2e8040cc56cff` |

The product tree is **not equal to the standalone PR head tree**. The transport independently rechecks both commits, parents, repository/run/head/attempt, artifact name/size/digest/expiry, then hashes the downloaded ZIP. The driver repeats source/tree/parents/ZIP checks and uses the source's `productionApplication` compiled attestation plus the API's exact `/api/version` result. `metadata-readback.json` records the preparation-time read-only verification; it is not a download or runtime receipt.

## Publication mapping and invocation

The owner publishes only these reviewed operations files:

| Local file | Operations branch path |
| --- | --- |
| `workflow.yml` | `.github/workflows/issue1512-sql-profile-1f548.yml` |
| `driver.mjs` | `.github/issue1512-sql-profile-1f548/driver.mjs` |
| `artifact.mjs` | `.github/issue1512-sql-profile-1f548/artifact.mjs` |
| `driver.test.mjs` | `.github/issue1512-sql-profile-1f548/driver.test.mjs` |

The workflow runs only on `ops/1512-git-transport`, the matching path change, and the exact message prefix `issue1512:profile-1f548 `. It has a 20-minute job limit, fresh job-local PostgreSQL 17, Node 24.22.1, pinned pnpm 10.34.3, and no browser installation. The GitHub token is scoped to the artifact transport step and is rejected if present in the diagnostic process. Signed download URLs remain in RAM. There is no OIDC, deployment, subscription or provider call.

```sh
node ops/.github/issue1512-sql-profile-1f548/driver.mjs \
  --source "$GITHUB_WORKSPACE/source" \
  --artifact-zip "$RUNNER_TEMP/desktop-api-build.zip" \
  --output "$GITHUB_WORKSPACE/evidence/desktop-query-decomposition.json"
```

The original driver and the earlier 0d33 profile remain unchanged.

## Fixed request plan: 24 requests

| Requests | Purpose / validation |
| --- | --- |
| Web sign-in and get-session | Original leased account's normal reauthentication; two separately measured requests |
| Web `desktop.bootstrap`, `desktop.session` | Ordinary default workspace plus explicit session cost comparison |
| Web `/api/workspace`, `/api/live/ticket` | Settings of the actual fixture team; ticket for the actual personal home returned by that authorized settings response |
| Native sign-in and get-session | Same ordinary reauthentication after the Web HTTP context closes; preserve the multi-session ordering |
| PKCE begin | Original nonce/challenge and actual one-shot owned loopback listener |
| System-browser `/api/desktop/config`, `desktop.session` | 1f's auth-only confirmation contract; no obsolete confirmation-page workspace bootstrap |
| PKCE return and exchange | Original code/verifier flow; session must match the authenticated browser and leased owner; normal signed cache only |
| Native `desktop.bootstrap`, `desktop.session` | Same default fixture; original bearer and signed-cache transport |
| Two `task-runs.pollTaskRuns` | Actual ended fixture task must be returned; measure separate ordinary calls |
| `task-runs.syncThreadList`: first and cursor | Keep actual returned version/positions; the next request must return unchanged under the same owner/home |
| `coordinator.syncCoordinatorChat`: first and cursor | Normal null bot selector; verify actual fixture Coordinator; reuse returned version/continuation and metadata keys |
| One `desktop.readBatch` | Task read plus the exact previously measured thread/chat cursor arguments; validate three successful results in original order |
| Native `/api/workspace`, `/api/live/ticket` | Same selected team and verified personal home as the Web calls |

The batch is one physical request with three real logical actions. Its measured query count is compared with the separately observed task-second/thread-cursor/chat-cursor sum, without claiming causality beyond this sequence.

The fixture team and owner-wide personal home are different scopes. No home UUID is invented or borrowed from the team. The settings response supplies it; each owner-wide read must carry that exact owner/home. IDs and cursor values stay in memory and never enter the report.

## Runtime, cleanup and count boundaries

The source's existing `startLiveWorker` starts one local Miniflare gateway with a fresh private key. The normal `DEVICE_GATEWAY_URL` and `DEVICE_GATEWAY_PUSH_SECRET` conditions therefore match Native acceptance. This matters: `syncThreadList` performs an additional queued-device read when the gateway is configured, and the ticket route must actually issue a ticket. This diagnostic opens no Live WebSocket and does not reproduce a browser catch-up. The disabled fixture device and ended task remain unchanged.

The driver uses the unchanged 735 `db-metrics.cjs` and `createLifecycleQueryCounter`. Every request has before/after snapshots, same PID/runtime/start checks, complete body drain, and zero unknown readings. Gaps between requests and before cleanup are retained, never subtracted. PostgreSQL protocol byte deltas are connection-level measurements, not SQL text bytes or exact per-statement result sizes. Harness lease/fixture SQL and the gateway's separate process are outside the primary API counter, as in the existing harness.

An eight-minute driver budget and 15-second individual HTTP limits remain. Only existing bounded API/gateway startup readiness runs; no new business polling, sleep, retry, or automatic repeat of the diagnostic is added. Unchanged-cursor assertions fail instead of retrying.

Cleanup closes HTTP contexts and the exact owned loopback; consumes/removes only the generated PKCE row under its nonce/challenge/callback/owner predicates; invokes original fixture cleanup and lease release; drains the owned API before disposing the owned gateway; and removes private account/runtime files and metrics socket. A forced shutdown or missing disposal acknowledgement remains failed evidence. The workflow separately removes the downloaded ZIP/tar and reports PostgreSQL teardown as pending its actual Stop containers step.

## Output and validation boundary

Only `artifact-receipt.json`, `desktop-query-decomposition.json`, and `runner-receipt.json` are uploaded. They contain fixed labels, version/commit/digest metadata, counts, timestamps, booleans and closed failures. No API body, cursor, row, SQL, account/fixture ID, transcript, email, token, signed URL, raw API log or gateway protocol is retained. Original authentication/user/session values are consumed only in RAM. Report size stays under 256 KiB and files are mode 0600.

The safe `readCosts` summary leaves missing results null. `summary.fullNativeWindowReconciliation` is always null and `productionAcceptance` remains false. Source-only tests exercise scope refusal, cursor/version refusal, safe receipts and exact batch argument preservation; they do not prove real PostgreSQL, PKCE, Linux runtime or macOS acceptance. Actual execution remains the owner's next reviewed step.
