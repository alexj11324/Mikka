# Smoke runtime inventory — 41788650583

The normal read-only inventory **passed** on 2026-11-04 at **06:54:59.706–06:55:04.025 UTC**. It made six GET requests in one fresh authenticated Smoke session and logged out successfully. This result is an inventory observation, not a task or Cloud/device handoff acceptance.

## Observed result

| Check | Original report |
|---|---|
| GitHub | configured=true; connected=false; installed=false |
| Authorized repositories | 0, not truncated |
| Repository isolation / write permission verified | false / false |
| Visible devices | 1 existing cloud device; online=false; onlineCount=0 |
| Device registration / harness readiness verified | false |
| Login / verified session | HTTP 200 / true |
| Logout / session ended | HTTP 200 / true |
| Errors | none |
| Model calls / authorization changes | 0 / 0 |
| Repository creation / Cloud creation / provider refresh | false / false / false |

The stored push and pull-request permission fields are explicitly legacy settings. Their values do not establish a connected GitHub identity, an authorized repository, or write access.

At this observation there is still no verified repository authorization for the proposed same-owner E2B Cloud A → independent Actions device B scenario. The source-backed [earlier feasibility assessment](https://github.com/alexj11324/Mikka/blob/5ebeb870182d15b6fe2be7157bade0c0237c4884/.github/pr-evidence/1161-cloud-device/20261104-smoke-review.md) explains why a public GitHub URL does not bypass normal owner dispatch authorization. No device was paired and no task was created to force this experiment. No new GitHub/OAuth grant or sharing change was made. The previous historical assessment remains unchanged; this directory records the new observation separately.

## Fixed source and integrity

- Workflow: [41788650583](https://github.com/alexj11324/Mikka/actions/runs/41788650583), job 126436571109, attempt 1, success.
- Driver head: dc9e5e624485c8930ad439e7bdda18733a9e1c46.
- Observed app source: aa50444a0b5012d2d35ca730c3ca722c0057d596.
- Deployment before and after: dpl_3w4SnCqaoFhayN8QCU6UGc4vuARw.
- Artifact 13301488872: original ZIP **760 bytes**, SHA256 **3ed49b70f2baaae5bfc542cdd2c3cd4d984890a99e4482f46c98240f40f7695e**.
- Original results.json: **1626 bytes**, SHA256 **27972b274cce59a704e3dbe662ada4b8bcee256a47f0aa645262565ce3d4521a**.

The GitHub artifact API digest, downloaded ZIP length and independently computed byte hashes match. The ZIP and JSON are preserved without rewriting. Relative to original driver head 7864751e77fd13a7d4ed791f20e412d6e54dd4a8, runtime-capabilities.mjs and both contract-test files are byte-identical; subscription-inventory.mjs changes only its source revision and deployment constants. The workflow's offline contracts and source verification steps succeeded before credentials were supplied. Archival performed no new production login, model call, SQL query, provider action or deployment.

The newly observed app revision is an immutable observation pin, not a claim about every later production deployment. See provenance.json for file blobs, pin-only differences, artifact metadata and verification commands.
