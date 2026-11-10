# Origins and the OAuth proxy

> Mikka's own pull requests and branches have no Vercel Preview: Vercel builds
> nothing from Git (`vercel.json` `git.deploymentEnabled`), every build runs on
> GitHub Actions, and only `main` deploys, to production
> ([decision 2026-11-05-1632](design/decisions/2026-11-05-1632-no-vercel-preview.md)).
> Verify a change before merge in CI or with `pnpm build:app` + `pnpm start` in a
> cloud Linux or Docker sandbox against an isolated database
> ([dev workflow](dev-workflow.md) § 5, [acceptance](acceptance.md)). Do not
> create deployments with the Vercel CLI or API, and do not change Vercel
> settings. This page covers the auth origin and the OAuth proxy.

Every runtime authenticates against its own exact origin. Set `BETTER_AUTH_URL` to the current origin without `/mikka`. If omitted, `lib/auth-config.ts` uses `VERCEL_URL` in preview mode, otherwise `VERCEL_PROJECT_PRODUCTION_URL` followed by `VERCEL_URL`, then the configured v0/Cloudflare Pages URL. The code still selects the Neon integration's branch-specific `DATABASE_URL` on a Vercel `preview` environment, but no such deployment is built for Mikka's branches. Other environments retain their existing database selection.

## Google and GitHub login

Use Better Auth's built-in OAuth proxy so a non-production origin does not require changing provider registrations. Set `BETTER_AUTH_OAUTH_PROXY_URL` to the stable callback hub origin on both the hub and participating origins. Set the same dedicated `BETTER_AUTH_OAUTH_PROXY_SECRET` on those deployments, alongside matching Google/GitHub client credentials. Keep `BETTER_AUTH_SECRET` separate for each environment. The proxy exchanges the provider code on the hub and completes login against the originating origin's database; it does not create that user or session in the hub database.

Register these exact provider callbacks when the hub is `https://app.aspectlylabs.com`:

```text
https://app.aspectlylabs.com/mikka/api/auth/callback/google
https://app.aspectlylabs.com/mikka/api/auth/callback/github
```

Use the corresponding exact callback paths if the hub changes. The proxy URL is an origin, without `/mikka` or `/api/auth`. Install the same application configuration on the hub and participating origins; setting both proxy variables enables the plugin. A missing proxy variable leaves direct provider callbacks enabled. Provider credentials and secrets belong in Infisical and the hosting environments, never in committed files or `.env.local`.

Actual `VERCEL_URL`, `VERCEL_BRANCH_URL`, `VERCEL_PROJECT_PRODUCTION_URL`, `V0_RUNTIME_URL`, `V0_DEV_APP_URL`, `V0_BUILD_URL`, `V0_SANDBOX_URL` and `CF_PAGES_URL` origins are trusted in every runtime mode. A changing v0 origin such as `https://ios-kn1ogl39.v0.build` therefore trusts only its configured exact origin automatically. No central origin registry, provider callback update or `*.v0.build` wildcard is needed: the installed OAuth proxy authenticates the encrypted authorization-state package using the dedicated shared proxy secret, then returns the encrypted provider profile to the issuing origin's origin-bound completion URL. That origin restores its own OAuth state and creates its own session. The hub can trust only itself; it does not need every changing origin in its allowlist. Deployments receiving the shared proxy secret are trusted participants.

Use `AUTH_TRUSTED_ORIGINS` only for additional project-controlled HTTPS origins or project-scoped hostname patterns needed by direct auth requests. Never trust shared hosting domains such as `*.vercel.app`, `*.v0.build`, `*.pages.dev` or `*.workers.dev`. Workers deployments without `CF_PAGES_URL` must set their exact `BETTER_AUTH_URL` and any additional controlled origins. Invalid non-HTTPS origins, credentials or URL paths fail configuration validation.

For localhost development in cloud Linux, set `BETTER_AUTH_URL=http://localhost:3000` and use development mode (`pnpm dev`, Vite + Nitro). The cloud edition allows HTTP loopback origins in development, CI and a production build using local test-account mode. Community deployments also allow HTTP loopback. Other origins and the OAuth proxy hub require HTTPS. In the cloud edition, inject the matching provider credentials and both proxy variables to return through the same fixed hub, without adding localhost callbacks in Google Console. Without the proxy variables, use a separate development OAuth client with `http://localhost:3000/mikka/api/auth/callback/google` registered. Community deployments reject the shared OAuth proxy variables. Local HTTP uses Better Auth's default cookies; HTTPS development origins retain partitioned cookies. Keep real credentials out of local files.

For OAuth-proxy changes only: validate login from the originating origin under test: the provider authorization URL must name the stable hub callback, then return to that origin and create its own session. Confirm a foreign origin cannot initiate a trusted callback. Unit tests validate configuration and real Better Auth request handling without starting a local server; real provider login needs the OAuth proxy described above.

OAuth-specific runtime acceptance follows [acceptance.md](acceptance.md#oauth-specific-acceptance). Reuse authorized Google/GitHub sessions and verify the exact return origin. Shared application acceptance uses the existing SMOKE account in Acme Inc.
Isolated regression harnesses use their registered fixture accounts as
[acceptance.md](acceptance.md) describes.

Google login requests only `openid`, `email`, and `profile`. Google branding verification requires a public Mikka homepage with a service description and links to privacy and terms pages on a verified domain; the product site is maintained separately from this application repository.
Verify its actual published pages and provider-console status for a branding
review. Existing email/password users can sign in with their password and link Google under Settings → Account; Mikka keeps Better Auth's verified-email account-linking check enabled.

## Composio

Plugins → GitHub (linking a GitHub account for repositories) does not use the proxy: GitHub answers the origin the link started on ([decision](design/decisions/2026-11-03-0315-github-link-callback-origin.md)). A non-production origin that links GitHub needs `https://<origin>/mikka/api/auth/callback/github` registered on the GitHub App and a stable `BETTER_AUTH_URL`; an unregistered origin stops on GitHub's `redirect_uri` error.

Notion and Slack connections use Composio-managed OAuth and the signed-in Mikka user ID. Set `COMPOSIO_API_KEY` on the server. Configure Composio's callback verifier for the intended cloud deployment's `/mikka/api/integrations/composio/callback`, and set that exact URL in `COMPOSIO_CALLBACK_VERIFIER_URL`. Mikka only starts connection flows when those values match, and Composio keeps the connection pending until the signed-in Mikka user completes it. The social-login proxy does not relay Composio or Linear OAuth callbacks.

Composio outbound event delivery uses a webhook subscription. Configure its URL as the intended cloud deployment's `/mikka/api/webhooks/composio`, select event types, and save the signing secret as `COMPOSIO_WEBHOOK_SECRET`. The receiver verifies and acknowledges events; app-specific event actions still need to be selected.
