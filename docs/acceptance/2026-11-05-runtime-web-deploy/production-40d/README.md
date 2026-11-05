# Completed production verification for PR 1302

The repaired runtime publication path passed on **2026-11-05**, following the normal main push. Root performed the production observations; this evidence retains its safe responses and log excerpts unchanged.

- PR source head: `c9da99ff14d7fd3446e0417d3a54fc0408442dff`.
- Squash merge and deployed source: `40d03479ea8260b8934f609b84c7c9cb60a94b3c`.
- Source tree: `58f14e63fc36cf12a936b9825604f71162586a84`, identical before and after squash.
- Exact-head CI: 26 completed checks, 21 success and 5 expected conditional skips; all 6 workflows succeeded. Root verified the merge preview and performed the squash.

## Actual publication sequence

| Boundary | Observed evidence |
| --- | --- |
| Normal Web deployment | [Web deploy 41950780159](https://github.com/alexj11324/Mikka/actions/runs/41950780159) succeeded, including GitHub build, prebuilt upload and public version verification. An independent unauthenticated GET at `01:52:43.501Z` returned HTTP 200 and the full merge SHA. |
| Refresh trigger | [E2B runtime 41950779968](https://github.com/alexj11324/Mikka/actions/runs/41950779968) observed current main and `Runtime release control refresh: true`. The worker hash was unchanged (`02da9281a5e8b0c44995b4a48931eee0a7de6f6f`), so this exercised the new publication-control path rather than relying on a worker change. |
| Official-instance validation | The existing validation job succeeded for desktop, Claude and Codex. Its preserved-entry counts were 3,826, 2,134 and 9,482, with the actual manifest digests retained in `production-validation-excerpt.json`. |
| Waiting outside the shared queue | The `await-web` job succeeded and identified exact Web run `41950780159`, attempt 1, plus public build `40d03479…`; it did not treat an earlier READY deployment or a skipped build as evidence. |
| Reusable production job | Job [126995845184](https://github.com/alexj11324/Mikka/actions/runs/41950779968/job/126995845184), `publish / deploy`, succeeded. Actual OIDC-backed credential steps, current-main checks, environment upsert/readback, GitHub build, prebuilt upload and public verification all succeeded. This verifies that the existing identity accepted the reusable job's actual claims, without changing identity trust. |
| Environment publication | The safe event at `01:52:20.3091533Z` records `changed: true`, `requiresWebBuild: true`, the exact source commit and worker hash. The job then built in GitHub Actions instead of requesting a Vercel source rebuild. |
| Final deployment and alias | The deployed URL was `mikka-30j3buflx-mikka-dev.vercel.app`; the production alias moved from `dpl_FNPDNzS3isGCQNrLyK6KLbwXcAjh` to `dpl_2W5DCuSdABTVGcPbnr9xjtV2eczj`. The final deployment was READY, target production, source `cli`, with exact GitHub commit metadata matching the job and current main. |
| Independent final version | At `01:57:42.145Z`, unauthenticated `https://app.aspectlylabs.com/mikka/api/version` returned HTTP 200 and `build: 40d03479ea8260b8934f609b84c7c9cb60a94b3c`. Root completed the final gate at `01:57:44.089Z`. |

All five E2B workflow jobs succeeded: test, check, validate, await-web and publish/deploy. `production-final-proof.json` contains the exact job/step results, both alias/deployment observations, current-main readback and the final unauthenticated response. Its SHA-256 is `8e8a985af2d138a182f7dcdba755076ce0a457d4acd9f545e93f219ea2bf0c1a`.

Infisical's generic secret masking altered parts of the job's version log line (for example, `***uction_version_verified`). That excerpt remains exactly as retrieved; it is not repaired or substituted. The independent public GET provides the unmasked full-SHA version evidence.

## Scope and retained limitations

This verifies the deployment-chain repair in production. It does **not** complete PR 1217's paid local-loop cloud leg, any of the three user-selectable model paths, the hour-long egress comparisons, or all requirements of tracking issues 1210/1211/1212. Those remain separately tracked.

The preceding failure evidence is retained: the old publisher rejected a new GitHub-built source before Vercel could see its upload, and a later old publisher actually requested a Vercel source rebuild. The new successful run does not erase those failures.

No deployment was deleted, shared token revoked, identity/trust policy changed or production database setting modified for this repair. The production writes were the authorized runtime environment publication and the existing GitHub Web deployment flow. Local test and source evidence remains in the parent directory; this folder adds production observations rather than re-labelling local tests as production acceptance.

`manifest.json` records the byte counts and SHA-256 digests of the immutable source observations. Root owns the tracking-issue progress comment; the publishing agent adds a result comment only to PR 1302.
