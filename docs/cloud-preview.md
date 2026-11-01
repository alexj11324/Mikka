# Cloud Preview development

> Development and acceptance are local first ([dev workflow](dev-workflow.md));
> Vercel does not build pull requests. This page covers Preview origins and the
> OAuth proxy for the cases that need a deployed origin.

Preview deployments Vercel previews, v0 previews and Cloudflare-hosted previews use their own HTTPS origin and an isolated Preview database. Set `BETTER_AUTH_URL` to the current origin without `/mikka`; if omitted, Vercel Preview prefers its deployment URL, and v0/Cloudflare Pages use their supplied preview URL. Vercel Preview uses the Neon integration's branch-specific `DATABASE_URL` ahead of the global `MIKKA_DATABASE_URL` override. Other environments retain their existing database selection.

## Google and GitHub login

Use Better Auth's built-in OAuth proxy so changing Preview URLs do not require changing provider registrations. Set `BETTER_AUTH_OAUTH_PROXY_URL` to the stable callback hub origin on both the hub and participating previews. Set the same dedicated `BETTER_AUTH_OAUTH_PROXY_SECRET` on those deployments, alongside matching Google/GitHub client credentials. Keep `BETTER_AUTH_SECRET` separate for each environment. The proxy exchanges the provider code on the hub and completes login against the originating Preview database; it does not create the Preview user or session in the hub database.

Register these exact provider callbacks when the hub is `https://app.aspectlylabs.com`:

```text
https://app.aspectlylabs.com/mikka/api/auth/callback/google
https://app.aspectlylabs.com/mikka/api/auth/callback/github
```

Use the corresponding exact callback paths if the hub changes. The proxy URL is an origin, without `/mikka` or `/api/auth`. Install the same application configuration on the hub and previews; setting both proxy variables enables the plugin. A missing proxy variable leaves direct provider callbacks enabled. Provider credentials and secrets belong in Infisical and the hosting environments, never in committed files or `.env.local`.

Actual `VERCEL_URL`, `VERCEL_BRANCH_URL`, `VERCEL_PROJECT_PRODUCTION_URL`, `V0_RUNTIME_URL`, `V0_DEV_APP_URL`, `V0_BUILD_URL`, `V0_SANDBOX_URL` and `CF_PAGES_URL` origins are trusted in every runtime mode. A changing v0 origin such as `https://ios-kn1ogl39.v0.build` therefore trusts only its configured exact origin automatically. No central preview registry, provider callback update or `*.v0.build` wildcard is needed: the installed OAuth proxy authenticates the encrypted authorization-state package using the dedicated shared proxy secret, then returns the encrypted provider profile to the issuing Preview's origin-bound completion URL. The Preview restores its own OAuth state and creates its own session. The hub can trust only itself; it does not need every changing Preview origin in its allowlist. Deployments receiving the shared proxy secret are trusted participants.

Use `AUTH_TRUSTED_ORIGINS` only for additional project-controlled HTTPS origins or project-scoped hostname patterns needed by direct auth requests. Never trust shared hosting domains such as `*.vercel.app`, `*.v0.build`, `*.pages.dev` or `*.workers.dev`. Workers deployments without `CF_PAGES_URL` must set their exact `BETTER_AUTH_URL` and any additional controlled origins. Invalid non-HTTPS origins, credentials or URL paths fail configuration validation.

For localhost development, set `BETTER_AUTH_URL=http://localhost:3000` and use development mode (`pnpm dev`). HTTP loopback origins are allowed only in development and CI; other origins and the OAuth proxy hub still require HTTPS. Inject the matching provider credentials and both proxy variables to return through the same fixed hub, without adding localhost callbacks in Google Console. Without the proxy variables, use a separate development OAuth client with `http://localhost:3000/mikka/api/auth/callback/google` registered. Local HTTP uses Better Auth's default cookies; HTTPS development previews retain partitioned cookies. Keep real credentials out of local files.

Validate login from each deployed Preview: the provider authorization URL must name the stable hub callback, then return to the originating Preview and create its own session. Confirm a foreign origin cannot initiate a trusted callback. Unit tests validate configuration and real Better Auth request handling without starting a local server; real provider login needs the OAuth proxy described above.

Runtime acceptance follows [acceptance.md](acceptance.md): use direct Google/GitHub OAuth, reuse authorized sessions, and do not repeatedly ask the user for a Mikka password.

Google login requests only `openid`, `email`, and `profile`. Google branding verification requires a public Mikka homepage with a service description and links to privacy and terms pages on a verified domain; those pages are not in this repository yet. Existing email/password users can sign in with their password and link Google under Settings → Account; Mikka keeps Better Auth's verified-email account-linking check enabled.

## Composio

Notion and Slack connections use Composio-managed OAuth and the signed-in Mikka user ID. Set `COMPOSIO_API_KEY` on the server. Configure Composio's callback verifier for the intended cloud deployment's `/mikka/api/integrations/composio/callback`, and set that exact URL in `COMPOSIO_CALLBACK_VERIFIER_URL`. Mikka only starts connection flows when those values match, and Composio keeps the connection pending until the signed-in Mikka user completes it. The social-login proxy does not relay Composio or Linear OAuth callbacks.

Composio outbound event delivery uses a webhook subscription. Configure its URL as the intended cloud deployment's `/mikka/api/webhooks/composio`, select event types, and save the signing secret as `COMPOSIO_WEBHOOK_SECRET`. The receiver verifies and acknowledges events; app-specific event actions still need to be selected.
