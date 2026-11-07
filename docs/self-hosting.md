# Self-hosting Mikka

The community edition runs on your own server and database. It does not need a Mikka account, Stripe, Vercel, Cloudflare, or a Mikka-owned API key. Your subscriptions and API keys belong to you. Hosted Mikka billing is disabled in the community edition.

## Start the server

Use a Linux host with Docker Engine and Docker Compose 2.24 or newer. The first published image targets `linux/amd64`. Start with 2 CPU cores and 4 GB RAM for the application and PostgreSQL; running coding agents on this same host needs additional resources. The application listens on port 3000 and is served at `/mikka`. This version supports a configurable origin; the `/mikka` path is fixed in the compiled web application.

Download `docker-compose.yml` from the release you plan to run. In the same directory, create a `.env` file:

```dotenv
POSTGRES_PASSWORD=replace-with-a-random-hex-password
BETTER_AUTH_URL=http://localhost:3000
# Pin a published commit SHA or release tag for repeatable upgrades.
MIKKA_IMAGE=ghcr.io/alexj11324/mikka:latest
```

Generate the database password with `openssl rand -hex 32`. Do not use a sample password. Keep `.env` private (`chmod 600 .env`); it is not part of the image or source control.

```sh
docker compose up -d --wait
```

Open `http://localhost:3000/mikka`. Compose starts only the app and PostgreSQL. PostgreSQL has no exposed host port. At each application start, the existing migrations run before the HTTP listener starts. An advisory lock serializes migrations across replicas. Workflow uses its local backend and stores its durable state in the app data volume.

The app port binds to `127.0.0.1` by default. For remote access, put a TLS reverse proxy on the host and set `BETTER_AUTH_URL=https://mikka.example.com`. The value is an **origin**, without `/mikka`, credentials, a query, or a fragment. Forward `Host` unchanged, support WebSocket upgrades, and forward the original HTTPS scheme. The server rejects conflicting forwarded hosts or schemes. HTTP is accepted only for a configured loopback origin; use HTTPS for a network deployment.

If you publish a different host port, set both `MIKKA_PORT` and the port in `BETTER_AUTH_URL`. Configuration takes effect when the container is recreated:

```sh
docker compose up -d --force-recreate app
```

## Installation secrets and backups

On first start, the app creates independent random keys for authentication, workspace secrets, the credential vault, live/device tickets, and cron authorization. They are stored with mode `0600` in `/data/installation-secrets.json`. The image contains no shared encryption key. Explicit environment values take precedence and are never copied into that file.

Back up **both** the PostgreSQL volume and the app data volume. Losing the database loses your content; losing the installation keys prevents decrypting saved credentials and invalidates sessions. Recreating the app container preserves both named volumes. `docker compose down --volumes` deletes them, so do not use that command for an upgrade.

To use externally managed secrets, configure `BETTER_AUTH_SECRET`, `WORKSPACE_SECRETS_KEY`, `CREDENTIAL_MASTER_KEY`, `DEVICE_GATEWAY_PUSH_SECRET`, and `CRON_SECRET`. Encryption keys are 32 bytes encoded as base64 (`openssl rand -base64 32`). Multiple app instances must share the same keys and database. Preserve the local Workflow data directory; do not place independent local Workflow stores behind a load balancer until the durable queue topology has been configured for that deployment.

## Email and sign-in

Email sign-in needs an email sender for verification and password reset. Configure `MIKKA_EMAIL_FROM` and either `SMTP_URL` or `RESEND_API_KEY`; SMTP takes precedence when both are present. For example:

```dotenv
MIKKA_EMAIL_FROM=Mikka <mikka@example.com>
SMTP_URL=smtps://username:password@smtp.example.com:465
```

Use your own Google or GitHub OAuth clients. Register callbacks on your exact origin:

| Provider | Environment | Callback |
| --- | --- | --- |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `https://mikka.example.com/mikka/api/auth/callback/google` |
| GitHub sign-in | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | `https://mikka.example.com/mikka/api/auth/callback/github` |

`AUTH_TRUSTED_ORIGINS` can add explicitly trusted origins when needed. It does not change the application's canonical origin. Your deployment uses its own OAuth credentials; it does not borrow Mikka's login proxy.

## Models, computers, and GitHub

In **Settings → Models and subscriptions**, connect your own Claude or ChatGPT subscription, or add your own provider API key. The community edition does not reserve Mikka credits, require a payment card, or stop after the hosted free-message allowance. It hides the Billing settings section. The normal user/workspace permissions and model access rules still apply.

To supply the server's default OpenAI-compatible model, set `MIKKA_DEFAULT_MODEL_BASE_URL`, `MIKKA_DEFAULT_MODEL_API_KEY`, and `MIKKA_DEFAULT_MODEL_ID`. Use the provider's API base, including its version path where required. Provider charges go to your account. Without a configured default model, choose one of your own available models.

Connect your own computer or server using the commands shown in Mikka's **Devices** settings. Copied commands always include `--server` with the current origin and `/mikka` path. The daemon's standalone CLI keeps its existing official-server default, so retain the flag for a self-hosted installation.

For an E2B cloud computer, save your own E2B key in your account. This does not buy Mikka-hosted compute and does not charge Mikka credits.

GitHub repository access uses your deployment's GitHub App. Manual configuration uses `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_CLIENT_ID`, and `GITHUB_CLIENT_SECRET` as required by the integration. The installation link is derived from the configured slug. It never sends a community user to the official Mikka App by default. The current OAuth configuration also enables GitHub sign-in; keep its callback registered on your own origin.

## Edition and hosted deployment

`MIKKA_EDITION` is read at runtime through `lib/edition.ts`. Its default is `community`; the only other accepted value is `cloud`. Invalid values fail configuration rather than silently choosing a billing mode. The same image can be used with a new origin without rebuilding its browser assets.

Official Mikka production must explicitly set `MIKKA_EDITION=cloud` through Infisical `prod:/vercel` and its existing Vercel sync before this default reaches production. Its Stripe checks, trial limits, reservation/settlement, and existing providers remain enabled. The previous domain redirect is separately configured with `MIKKA_LEGACY_APP_HOST`; it grants no authenticated access through the old host.

Optional Mikka cloud services are a separate connection. The community edition remains usable without connecting them. The hosted-compute resale option is not included; its pricing decision is tracked separately in #1569.

## Build, verify, and upgrade

Build the public application from a checked-out revision:

```sh
docker build --build-arg MIKKA_BUILD_REVISION="$(git rev-parse HEAD)" -t mikka:local .
MIKKA_IMAGE=mikka:local docker compose up -d --wait
node scripts/self-hosted-smoke.mjs
```

The build uses the pinned pnpm lockfile, Vite frontend, Nitro Node server, and Node 24. It does not run migrations at image build time and does not require production credentials. `.dockerignore` excludes local environment files and private hosted UI. The runtime image contains the traced server dependencies and public assets, runs as an unprivileged user, and starts from its standalone output directory.

The **Self-hosted image** workflow builds the image, starts a clean PostgreSQL 17 database, checks migrations/startup health, verifies public configuration and static assets, and restarts the same persisted installation. A successful main build publishes `ghcr.io/alexj11324/mikka:<commit-sha>` and updates `latest`; release tags publish matching tags. Pin the SHA or release tag in `.env` before an upgrade, back up the two volumes, then run `docker compose pull` and `docker compose up -d --wait`.

`/mikka/api/version` reports the compiled revision. `docker compose ps` reports health. Startup logs include migration names and bounded error codes, never generated installation keys.
