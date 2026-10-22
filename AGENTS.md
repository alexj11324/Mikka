# Mikka development

- Develop and accept changes on cloud Preview deployments. Do not start a development server, database, browser acceptance environment, build or `tsgo` on the developer's Mac. Run builds and type checks in remote CI; use deployed previews for runtime checks. Small source-only unit tests may run without a server.
- Store project credentials in the Mikka Infisical Cloud project. Use cloud Secret Syncs and workload identities for delivery and Agent access. Never commit secret values or add credentials to local environment files.
- Google and GitHub sign-in use the stable HTTPS OAuth proxy hub configured by `BETTER_AUTH_OAUTH_PROXY_URL`. Give trusted previews the dedicated shared proxy secret through cloud configuration. Each preview uses its own exact runtime origin; changing v0 hosts do not require shared-domain wildcards.
- Preserve environment and Neon branch boundaries. Preview application data must use the matching cloud database with the required schema. Verify the deployed path after changing credentials or callbacks.
- Preserve unrelated changes and keep secret values out of terminal output, screenshots and reports.
- Follow `docs/acceptance.md` for runtime acceptance. Use direct Google/GitHub OAuth and reuse authorized browser sessions; do not require the user to enter a Mikka password for routine acceptance. Diagnose account-linking conflicts separately without weakening account ownership checks.
- Hand off the Agent's branch, commit SHA and unique Preview deployment URL. Keep that version fixed during acceptance; v0 `Latest`, moving branch aliases and the shared production domain cannot identify a frozen Agent delivery.

## Cursor Cloud specific instructions

Cloud Agent machines are not the developer Mac. Preview acceptance in `docs/acceptance.md` still uses a deployed Preview. On a Cloud Agent, `start` already runs the local stack:

- Node.js 24.22.1 is first on `PATH` via `/usr/local/node/bin` and `/etc/profile.d/mikka-node.sh`. The package manager is pnpm 10.34.3. PostgreSQL 17 cluster `17/main` is started by `start`.
- Local data is database `mikka_e2e` on `127.0.0.1`, role `e2e`, password `e2e-local-only` (the same isolated database as `.github/workflows/ui-policy.yml`). `start` runs `pnpm test:e2e:setup`. Do not point `MIKKA_DATABASE_URL` or `DATABASE_URL` at Neon from this machine.
- Mikka dev server: http://127.0.0.1:3000/mikka (`pnpm dev` in `mikka`). Product site: http://127.0.0.1:3001/mikka (`pnpm exec next dev --port 3001` in `mikka-web`). Both listen before `start` exits. Re-running `start` keeps servers that are already responding.
- Email/password sign-up works against this local database. A local-only `BETTER_AUTH_SECRET` is created at `/var/lib/mikka-dev/better-auth-secret`. Do not print it or copy it into the repo. Google and GitHub sign-in stay on the deployed Preview.
- Source checks that match CI and do not need the servers, from `mikka`: `pnpm test:ui-policy`, `pnpm test:motion`, `pnpm test:i18n`, `pnpm i18n:check`, `pnpm test:ssh-target`, `pnpm test:linear-sync`, `pnpm test:coordinator-events`, `pnpm test:auth-composio`, `pnpm test:integrations`, `pnpm test:csv`, `pnpm test:settings`, `pnpm test:issues`, `pnpm test:telegram`, `pnpm lint:code`, then `pnpm exec next typegen && pnpm typecheck`. In `mikka-web`: `pnpm typecheck`.
- `next dev` in `mikka-web` rewrites untracked `AGENTS.md` and `CLAUDE.md`. Leave those files uncommitted. The browser locale may open `/mikka/en`; Playwright sets `locale: 'zh-CN'`.
