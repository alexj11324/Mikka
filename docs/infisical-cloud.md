# Infisical cloud migration

Initial migration verified on 2026-10-22; identity discovery and private production delivery reverified on 2026-11-07 below. Organization: Aspectly Labs. Project: Mikka (`89850d6a-f020-4936-863e-df77380dfe40`). This inventory records names and dated migration receipts. Revalidate resource
metadata and the exact authorized action before operational use. Historical
Preview syncs and branch database snapshots remain records of their observed
state. Mikka's current branch workflow builds in cloud Linux/CI and publishes
only main to production ([deployment guide](operations/web-deploy.md)).

## Required identity reuse

**必须使用已有可用的 Infisical 身份；不限定 admin，也不限定非 admin。**

- 在已经授权的项目、环境和操作范围内，只要已有身份能完成任务，就必须复用；不能因为它不是 admin，或因为偏好另一个身份，而停止工作或新建 identity。
- 已有 admin 可用时可以直接使用；已有非 admin 身份可用时同样应直接使用。选择依据是能否完成当前任务，不是身份名称或类别。
- 不为了选择身份而新建 identity、增加身份数量、触碰免费额度或升级套餐。某一个身份不可用时，先核对其他现有可用身份；只有确认现有身份都不能完成必要操作时，才报告具体缺项，请用户决定后续处理。
- 不能把执行审核或规则保存失败写成用户禁止使用非 admin 身份；用户授权与执行限制必须分别记录。身份选择不改变当前任务的其他授权边界。

## Find credential metadata

Before reporting absent credentials, use the existing Universal Auth bindings
(`INFISICAL_API_URL`, `INFISICAL_PROJECT_ID`, `INFISICAL_CLIENT_ID` and protected
`INFISICAL_CLIENT_SECRET`) to locate their metadata:

```bash
python3 scripts/ops/infisical-discover.py --query SLACK
```

Repeat `--query` to match several key/path fragments. The CLI uses Python's
standard library and the environment's HTTPS proxy and verified CA trust. Its
authentication destination is exactly `https://app.infisical.com`; redirects
and proxy bypasses for that host are rejected. It supports existing Universal
Auth only, keeps the resulting token in memory, and requests no secret values.
It does not depend on a workspace-specific helper or credential file.

The CLI verifies the configured project's metadata and reads its actual
environment slugs before requesting recursive secret metadata from `/` with
`viewSecretValue=false`, `includeImports=true` and reference expansion disabled.
It reports every matching environment/path/key locator. Imported secrets retain
the source environment/path inherited from their import parent, separately from
the environment that was queried. Use these locators to choose the scope for
the already-authorized operation; discovery does not fetch values or choose a
cross-environment fallback.

Interpret the closed results before deciding what to do:

| Observation | Meaning |
| --- | --- |
| `action_denied` (403) | This identity cannot perform this request. It does not establish organization-wide denial. |
| `resource_unresolved` (404) | This resource, route or scope was not resolved for this request. Check the discovered locator and visibility. |
| `request_rejected` (422) | The API rejected the request; check the documented request shape/version. Do not guess a folder endpoint. |
| `visible_empty` / `no_visible_match` | The completed requests returned no visible entries/matches. ACL-filtered absence remains possible. |
| `incomplete` | At least one request, locator or pagination signal remains unresolved. Keep the partial matches and name the limitation. |

Exit 0 means the visible traversal completed, including an empty result; exit 2
means it was incomplete or unavailable. `permissionCompleteness` remains
`not_proven`: a successful metadata list does not prove visibility into every
secret. Unknown pagination signals produce an incomplete result rather than
an exhaustive claim. The output contains whitelisted metadata and closed
status codes; keep credential values and raw provider errors out of logs.

The public repository owns the reusable tool, required configuration interfaces,
generic discovery procedure and synthetic examples. Deployment-specific locator
inventories, identity mappings and investigation records belong in private
operational documentation; secret values remain in Infisical. The inventory is
discovered from the service, rather than maintained as a second configuration
store in documentation. Existing environment-specific probes keep their original
scope and are not a substitute for discovery.

This uses Infisical's documented [project/environment/folder hierarchy](https://infisical.com/docs/documentation/platform/secrets-mgmt/concepts/secrets-mgmt),
[metadata-only list API](https://infisical.com/docs/api-reference/endpoints/secrets/list)
and separate [describeSecret/readValue permissions](https://infisical.com/docs/internals/permissions/project-permissions).
These sources do not prescribe that every variable name or non-sensitive
configuration path must be private; keeping live operator inventories private
is our documentation ownership choice.

## Verified storage

All 89 application/database records were read back and compared to their prepared source values or expanded references. Environment/path counts include repeated names. Seven platform records and ten Worker secret references are stored separately. These counts establish storage, not deployed acceptance.

| Environment | Source folder | Records |
| --- | --- | --- |
| dev | `/neon` | 2 |
| dev | `/vercel` | 18 |
| prod | `/neon` | 2 |
| prod | `/vercel` | 24 |
| staging | `/branches/000add0cd5e4/neon` | 2 |
| staging | `/branches/75af16fa69ea/neon` | 2 |
| staging | `/branches/9232b5fc98ee/neon` | 2 |
| staging | `/branches/9f0508c4a0f7/neon` | 2 |
| staging | `/branches/b3185d332691/neon` | 2 |
| staging | `/branches/b3185d332691/vercel` | 8 |
| staging | `/branches/b89e448a67cc/neon` | 2 |
| staging | `/vercel` | 23 |

Application and database names:

`BETTER_AUTH_OAUTH_PROXY_SECRET`, `BETTER_AUTH_OAUTH_PROXY_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_TOKEN`, `COMPOSIO_API_KEY`, `COMPOSIO_CALLBACK_VERIFIER_URL`, `COMPOSIO_WEBHOOK_SECRET`, `CRON_SECRET`, `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `GITGUARDIAN_API_TOKEN`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_REDIRECT_URL`, `LINEAR_TOKEN_ENCRYPTION_KEY`, `LINEAR_WEBHOOK_SECRET`, `MIKKA_DATABASE_URL`, `NEON_API_KEY`, `OPENCODE_API_KEY`, `ORVILO_DATABASE_URL`, `REUI_LICENSE_KEY`.

Platform folder `prod:/platform`: `VERCEL_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `NEON_API_KEY`, `VERCEL_TEAM_TOKEN`, recovered `LINEAR_CLIENT_SECRET` and `LINEAR_WEBHOOK_SECRET`. `VERCEL_TEAM_TOKEN` is team-scoped and verified across all three current Mikka team projects; the earlier project-scoped `VERCEL_TOKEN` remains stored. The Cloudflare connection uses a dedicated account-scoped Worker sync token.

Google/GitHub credentials and Linear client/webhook secrets were recovered. Google client secret was subsequently replaced in all three Infisical source environments and synced to Vercel. Unreadable `CRON_SECRET`, `LINEAR_TOKEN_ENCRYPTION_KEY` and Cloudflare AI token were rebuilt with user authorization. Existing encrypted Linear tokens require reconnection after the new encryption key is deployed. Do not describe copied provider credentials as reissued credentials.

Neon integration-managed `DATABASE_URL` and `DATABASE_URL_UNPOOLED` are snapshots in `/neon` and branch folders. Neon remains their deployment writer. Do not send these snapshots through a second sync into integration-owned Vercel variables. The current cloud Preview `orvilo_mvp` database was checked for auth tables. New branches still require schema validation.

## Native cloud distribution

| Target | Current state |
| --- | --- |
| Vercel Mikka team | Shared organization-level native App Connection `mikka-team-vercel-native-sync` created with explicit team-wide authorization. Four syncs for Development, default Preview, Production and the existing Linear branch have succeeded; automatic sync is enabled. The temporary OAuth hub branch sync was removed after the fixed production hub was deployed. |
| Worker `mikka-linear-sync` | Native sync `mikka-workers-prod` succeeded and automatic sync is enabled. Deployed signature checks returned 401 for an invalid signature and 200 for a valid signature. |
| Worker `mikka-linear-sync-preview` | Native sync `mikka-workers-staging` succeeded and automatic sync is enabled. Deployed signature checks returned 401 for an invalid signature and 200 for a valid signature. |
| Worker `mikka-suggestions-cron` | Verified 2026-10-27: native sync `mikka-suggestions-cron-prod` succeeded and automatic sync is enabled. Dedicated source `prod:/cloudflare/suggestions-cron` contains only `CRON_SECRET`, referencing `prod:/vercel`; its expanded value matches Production. Worker and version preview URLs are disabled. Release and scheduled-run evidence are recorded in [PR #329](https://github.com/alexj11324/Mikka/pull/329); see [suggestions schedules](suggestions-cron.md). |
| Cloudflare Pages | No existing Mikka Pages project; no destination was invented. |
| Cloud workload | GitHub OIDC identity `mikka-github-cloud` uses 900-second tokens. On 2026-11-07 its existing Mikka project role was admin; its organization role was restored to `no-access` after controlled setup. Existing CI verified production native Sync readback without organization connection permissions. The older deleted-organization MCP record is migration history, not the current environment Universal Auth administrator; see the verified identity map below. |

Each Worker source `/cloudflare` contains only `CRON_SECRET`, `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_TOKEN_ENCRYPTION_KEY` and `LINEAR_WEBHOOK_SECRET`, referencing the matching environment in `/vercel`. Expanded references were compared to their base values. The existing Linear branch also references the default Preview credentials instead of owning duplicate shared values. Sync options prevent secret deletion. Worker settings were read before and after sync; unmanaged bindings, including Hyperdrive, were verified unchanged. No custom dispatch workflow was created.

The fixed OAuth hub is `https://app.aspectlylabs.com`. PR #46 was merged at `ae4f4572b33d5d4e033b58637da8d1b6764ce5bd` and deployed there. Development and staging reference that stable hub; each Preview keeps its own exact runtime origin. The temporary hub source folder and sync were removed. Real GitHub sign-in succeeded on a cloud Preview before the fixed-hub cutover. A new Preview using the replacement Google secret completed the provider round trip through the fixed hub and returned `account_not_linked`; Google session acceptance remains blocked by existing-account verification/linking state. Follow [runtime acceptance](acceptance.md): use direct OAuth and diagnose this state without repeatedly requesting a Mikka password or weakening ownership checks. The Google console no longer lists the exposed previous secret. An older unused key remains; it is not used by the migrated source values. Google now registers only the fixed hub callback; the temporary branch callback was removed.

Vercel's exact `VERCEL_BRANCH_URL` is trusted alongside the immutable deployment URL. An authenticated Better Auth regression verifies branch-alias sign-out while rejecting an unrelated deployment origin. No shared-host wildcard is added.

The OIDC trust pins the current numeric GitHub repository and owner IDs and immutable subject prefix, and accepts only the explicitly bound branch subjects. Existing hosted-UI main and private `mikka-cloud` main are also bound by numeric repository IDs; the private initial release branch is authorized temporarily until rollout completes. Pull request refs and forks cannot use this identity. Only `oidc-auth` is enabled; no persistent identity client secret was created.

## Issue #328 Preview isolation

Historical record. Pull requests and branches no longer get a Vercel Preview
([decision 2026-11-05-1632](design/decisions/2026-11-05-1632-no-vercel-preview.md));
verify before merge in CI or a local/Docker production build with an isolated
database.

Verified 2026-10-27. The default Preview database lacked the suggestions and
Coordinator schema. Neon had reached its branch limit, so two dedicated
databases were initialized on non-production branch `br-billowing-pine-b5fdxmtt`:
`mikka_issue328_acceptance` for the supplied `fe94ac2` and
`mikka_issue328_integrated` for the integration with current main. Keeping
them separate preserves the older Coordinator keys in the supplied version.
Existing Preview data and the Production database were left untouched.

Infisical staging sources `/branches/eaa84cc3f2a0/neon` and
`/branches/498b6cd0736f/neon` hold the respective database credentials. Their
matching `/vercel` folders contain only `DATABASE_URL` and
`MIKKA_DATABASE_URL` references. The existing native Vercel syncs were
preserved; creating another hit the plan's Secret Sync limit. The authorized
fallback wrote sensitive Preview variables scoped exactly to
`claude/suggestions-cloudflare-cron` and `codex/suggestions-cron-328`.
These two branch overrides require explicit resync after credential changes
until native sync capacity is available. No secret values were written to
local environment files.

GitHub App `mikka-github` already had the current OAuth callback. Its retired
installation Setup URL returned 404 and was changed to
`https://app.aspectlylabs.com/mikka`, which returned 200. This corrects the
landing page; repository authorization and PR status acceptance remain
tracked separately in [#330](https://github.com/alexj11324/Mikka/issues/330).

## Remaining acceptance

- Diagnose Google account verification/linking state and complete real Google session acceptance through OAuth. Remove the temporary GitHub branch callback after fixed-hub acceptance; the Google temporary callback is already removed.
- Verify Google/GitHub sign-in in production after merge. Branches have no Vercel Preview; remote CI and the production check remain separate evidence.
- Check the custom Linear integration callback separately; the Better Auth social proxy does not relay it. The existing Linear application webhook was corrected from the retired API host to `https://linear-sync.aspectlylabs.com/mikka/api/webhooks/linear`; real Linear event processing and token reconnection still need acceptance.
- Validate the required Neon schema on each new branch. Imported database snapshots do not establish branch runtime acceptance.
- Other Agent hosts still need their own supported workload authentication; the GitHub OIDC receipt only establishes that hosted runner path.
- No local development server, build or typecheck was run. The current application changes passed remote CI before PR #46 was merged; the branch-alias follow-up requires its own remote CI and production validation.

Official references: [Vercel integration](https://vercel.com/marketplace/infisical), [Worker native sync](https://infisical.com/docs/integrations/secret-syncs/cloudflare-workers), [secret references](https://infisical.com/docs/documentation/platform/secret-reference), [Better Auth OAuth proxy](https://www.better-auth.com/docs/plugins/oauth-proxy).


## Verified credential discovery and the 2026-11-07 403

The release investigation originally tested only `mikka-github-cloud` through
GitHub OIDC and incorrectly described its organization App Connection 403 as a
missing organization credential. The environment already had a usable Universal
Auth administrator identity. Both identities and the existing Vercel connection
belong to organization `5caa4fcb-2003-4fc1-8e1f-3a4de2cc05e6`. This was an
identity/action selection error, not two competing organizations. Do not delete
an organization to resolve it.

| Existing identity | Authentication and purpose |
| --- | --- |
| `token` (`264e0674-6468-4731-a57d-7bb1957f735b`) | Environment-configured Universal Auth with organization administration in the 2026-11-07 cloud receipt. Use existing `INFISICAL_*` bindings, never copy their values into the repository or terminal. |
| `mikka-github-cloud` (`2cf9fa19-b9db-4c08-8ca0-b31859f2cbac`) | GitHub Actions OIDC, audience `mikka-infisical`; production secret delivery inside the runner. Its project membership does not itself grant organization App Connection permissions. |

On Alex's Mac, `~/.codex/rules/infisical-api.md` specifies the signed
`/Users/alexjiang/.local/libexec/infisical-auth` helper and direct HTTPS API.
Its local `token` identity is documented with organization No Access and Mikka
project Admin. A shared identity name does not establish the same host's
credential or organization rights. Check effective metadata for the current
host and action without printing values. Cloud jobs use their configured
workload authentication.

For a new agent, check the presence of the configured variable names and the
existing authentication helper/startup notes supplied by its environment before
assuming only OIDC exists. In this cloud workspace those notes are
`/workspace/.tools/infisical-direct-startup.md`; the reusable
`UniversalAuthAPI` class is in `/workspace/.tools/infisical-direct-probe.py`.
Import the class for metadata/control-plane requests; do not run its unrelated
credential probe. These paths are environment instructions, not a requirement
for other hosts to copy credentials or depend on this workspace.

Before reporting a blocker, record only the API action/status, identity name/ID,
authentication method, and organization/project IDs. Test existing authorized
identities against the **same** action. A 403 on the organization connection
read route, a 404 from the wrong project route, and an empty connection list
are separate observations. In particular, check
`GET /api/v1/app-connections/vercel/available?projectId=<project>`: the built-in
organization Member role can Connect while being unable to Read an individual
connection. Do not require Read when the intended operation needs Connect.

The existing connection is `mikka-team-vercel-native-sync`
(`d5107d5c-fc41-4f42-a5b1-b77858811bdf`); the Mikka project is
`89850d6a-f020-4936-863e-df77380dfe40`. Production preparation temporarily used
the existing administrator to grant the existing OIDC identity the organization
Connect capability. Restore its previous organization role after preparation;
a native Secret Sync continues independently of the caller's token. Reuse the
administrator for future control-plane maintenance rather than inventing a
second identity or retaining unnecessary organization rights.

This metadata/control-plane discovery does **not** authorize pulling production
application secrets locally. Production setup, deployment, migrations and
acceptance run through the existing GitHub Actions workflows with OIDC and
Infisical. Log names and closed status summaries only; no secret values, raw
provider responses, private source, or credentials in public artifacts.


Final permission-restoration receipt: [Actions 42373968401](https://github.com/alexj11324/Mikka/actions/runs/42373968401)
succeeded at 2026-11-07T12:50:14Z, after the OIDC organization's previous
`no-access` role was restored. Source `84212867` requires connection Connect
only when creating/retargeting a Sync; the existing native Sync needs none.
Its `syncStatus` was `succeeded`, and metadata readback found all 26 private
production variables, including both Neon workspace variables, Expo access and
the retained data key. No new keys were created on this repeated run.
The private `core.yml` release also authenticated with the same existing OIDC
identity and applied the actual production cloud migrations on 2026-11-07;
publication and business acceptance have their own source-bound PR receipts.

### Existing Apple release names

The same `prod:/platform` inventory contains the existing Developer ID
certificate (`APPLE_DEVELOPER_ID_P12_BASE64`,
`APPLE_DEVELOPER_ID_P12_PASSWORD`, `APPLE_TEAM_ID`) and App Store Connect
credentials under **`ASC_API_KEY_P8`, `ASC_API_KEY_ID`,
`ASC_API_ISSUER_ID`**. Looking only for the older `APPLE_API_*` input names
misses the existing source; it is not evidence that Alex must create a key.

Desktop release and native iOS use their existing workflows and OIDC identity
to read these exact names. `scripts/release/apple-credentials.mjs` validates
the existing EC key and maps names to `CSC_*` / `APPLE_API_*` only inside the
trusted main runner, masking derived encodings before environment delivery.
It accepts the existing PEM or base64 representation; it does not generate,
rotate or copy a key into GitHub. OTA uses the existing `EXPO_TOKEN` in this
same folder. Temporary Apple key files stay runner-local and are removed.
