# Infisical cloud migration

Verified on 2026-10-22. Organization: Aspectly Labs. Project: Mikka (`89850d6a-f020-4936-863e-df77380dfe40`). This inventory contains names and migration status only.

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

Google/GitHub credentials and Linear client/webhook secrets were recovered. Unreadable `CRON_SECRET`, `LINEAR_TOKEN_ENCRYPTION_KEY` and Cloudflare AI token were rebuilt with user authorization. Existing encrypted Linear tokens require reconnection after the new encryption key is deployed. Do not describe copied provider credentials as reissued credentials.

Neon integration-managed `DATABASE_URL` and `DATABASE_URL_UNPOOLED` are snapshots in `/neon` and branch folders. Neon remains their deployment writer. Do not send these snapshots through a second sync into integration-owned Vercel variables. The current cloud Preview `orvilo_mvp` database was checked for auth tables. New branches still require schema validation.

## Native cloud distribution

| Target | Current state |
| --- | --- |
| Vercel Mikka team | Shared organization-level native App Connection `mikka-team-vercel-native-sync` created with explicit team-wide authorization. Development, default Preview, Production and existing Linear branch syncs have succeeded; automatic sync is enabled. Deployment rebuild and application acceptance remain pending. |
| Worker `mikka-linear-sync` | Native sync `mikka-workers-prod` created, automatic sync disabled pending coordinated app cutover. |
| Worker `mikka-linear-sync-preview` | Native sync `mikka-workers-staging` created, automatic sync disabled pending coordinated app cutover. |
| Cloudflare Pages | No existing Mikka Pages project; no destination was invented. |
| Cloud Agent | Workload identity and actual hosted consumption remain unconfigured. The old local MCP credential belongs to the deleted organization. |

Each Worker source `/cloudflare` contains only `CRON_SECRET`, `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_TOKEN_ENCRYPTION_KEY` and `LINEAR_WEBHOOK_SECRET`, referencing the matching environment in `/vercel`. Expanded references were compared to their base values. The existing Linear branch also references the default Preview credentials instead of owning duplicate shared values. Sync options preserve non-secret bindings such as Hyperdrive and prevent secret deletion. No custom dispatch workflow was created.

## Remaining acceptance

- Verify deployed consumers after native Vercel environment sync. The Marketplace installation returned canceled; the documented native App Connection succeeded with a dedicated team token.
- Switch app and Worker credentials together, verify native sync results and deployed API calls.
- Deploy the OAuth proxy configuration to its stable cloud hub and trusted previews; verify real Google/GitHub sign-in from changing Preview origins.
- Check the custom Linear integration callback separately; the Better Auth social proxy does not relay it. The existing Linear application webhook currently points to a retired API host and must be corrected to the verified Mikka receiver.
- Establish and verify cloud Agent authentication without a Mac service.
- Run remote CI and deployed Preview acceptance. No local server, build or typecheck was run.

Official references: [Vercel integration](https://vercel.com/marketplace/infisical), [Worker native sync](https://infisical.com/docs/integrations/secret-syncs/cloudflare-workers), [secret references](https://infisical.com/docs/documentation/platform/secret-reference), [Better Auth OAuth proxy](https://www.better-auth.com/docs/plugins/oauth-proxy).
