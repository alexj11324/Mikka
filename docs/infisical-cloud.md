# Infisical cloud migration

Verified on 2026-10-22. Organization: Aspectly Labs. Project: Mikka (`89850d6a-f020-4936-863e-df77380dfe40`). This inventory contains names and migration status only.

## Required identity reuse

**必须使用已有可用的 Infisical 身份；不限定 admin，也不限定非 admin。**

- 在已经授权的项目、环境和操作范围内，只要已有身份能完成任务，就必须复用；不能因为它不是 admin，或因为偏好另一个身份，而停止工作或新建 identity。
- 已有 admin 可用时可以直接使用；已有非 admin 身份可用时同样应直接使用。选择依据是能否完成当前任务，不是身份名称或类别。
- 不为了选择身份而新建 identity、增加身份数量、触碰免费额度或升级套餐。某一个身份不可用时，先核对其他现有可用身份；只有确认现有身份都不能完成必要操作时，才报告具体缺项，请用户决定后续处理。
- 不能把执行审核或规则保存失败写成用户禁止使用非 admin 身份；用户授权与执行限制必须分别记录。身份选择不改变当前任务的其他授权边界。

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
| Cloud workload | GitHub OIDC identity `mikka-github-cloud` configured with 900-second tokens, no organization access and read-only Mikka project membership. Existing CI successfully verified one injected Composio credential against its issuer on a GitHub-hosted runner, without a Mac service. The old local MCP credential belongs to the deleted organization. |

Each Worker source `/cloudflare` contains only `CRON_SECRET`, `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_TOKEN_ENCRYPTION_KEY` and `LINEAR_WEBHOOK_SECRET`, referencing the matching environment in `/vercel`. Expanded references were compared to their base values. The existing Linear branch also references the default Preview credentials instead of owning duplicate shared values. Sync options prevent secret deletion. Worker settings were read before and after sync; unmanaged bindings, including Hyperdrive, were verified unchanged. No custom dispatch workflow was created.

The fixed OAuth hub is `https://app.aspectlylabs.com`. PR #46 was merged at `ae4f4572b33d5d4e033b58637da8d1b6764ce5bd` and deployed there. Development and staging reference that stable hub; each Preview keeps its own exact runtime origin. The temporary hub source folder and sync were removed. Real GitHub sign-in succeeded on a cloud Preview before the fixed-hub cutover. A new Preview using the replacement Google secret completed the provider round trip through the fixed hub and returned `account_not_linked`; Google session acceptance remains blocked by existing-account verification/linking state. Follow [runtime acceptance](acceptance.md): use direct OAuth and diagnose this state without repeatedly requesting a Mikka password or weakening ownership checks. The Google console no longer lists the exposed previous secret. An older unused key remains; it is not used by the migrated source values. Google now registers only the fixed hub callback; the temporary branch callback was removed.

Vercel's exact `VERCEL_BRANCH_URL` is trusted alongside the immutable deployment URL. An authenticated Better Auth regression verifies branch-alias sign-out while rejecting an unrelated deployment origin. No shared-host wildcard is added.

The OIDC trust pins the current numeric GitHub repository and owner IDs and immutable subject prefix, and accepts only branch refs in that repository. Pull request refs and forks cannot use this identity. Only `oidc-auth` is enabled; no persistent identity client secret was created.

## Issue #328 Preview isolation

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
- Verify the branch-alias correction and Google/GitHub sign-in on the final deployed Preview. Remote CI and actual deployment checks remain separate evidence.
- Check the custom Linear integration callback separately; the Better Auth social proxy does not relay it. The existing Linear application webhook was corrected from the retired API host to `https://linear-sync.aspectlylabs.com/mikka/api/webhooks/linear`; real Linear event processing and token reconnection still need acceptance.
- Validate the required Neon schema on each new branch. Imported database snapshots do not establish branch runtime acceptance.
- Other Agent hosts still need their own supported workload authentication; the GitHub OIDC receipt only establishes that hosted runner path.
- No local development server, build or typecheck was run. The current application changes passed remote CI before PR #46 was merged; the branch-alias follow-up requires its own remote CI and Preview validation.

Official references: [Vercel integration](https://vercel.com/marketplace/infisical), [Worker native sync](https://infisical.com/docs/integrations/secret-syncs/cloudflare-workers), [secret references](https://infisical.com/docs/documentation/platform/secret-reference), [Better Auth OAuth proxy](https://www.better-auth.com/docs/plugins/oauth-proxy).
