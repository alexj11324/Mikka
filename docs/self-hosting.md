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

Forward both `/mikka/*` and the root `/.well-known/workflow/*` paths to this service; Nitro mounts its Workflow consumers at the origin root.

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

## Connect the official desktop app

Use a desktop release with self-hosted server selection. Enter
`https://mikka.example.com/mikka`; a bare `https://mikka.example.com` is also
supported by the desktop's discovery fallback. For a local installation, enter
`http://localhost:3000/mikka`. Network installations require HTTPS.

Set the optional `MIKKA_SERVER_NAME=Acme Mikka` to name this installation in the
server chooser. The server publishes its actual build revision and available
login methods at `GET /mikka/api/desktop/discovery`. This public endpoint needs
no session, returns JSON under 64 KB, and never redirects. The desktop sends
`x-mikka-client: desktop`, `x-mikka-client-version` and
`x-mikka-desktop-protocol: 1` when probing it. The response contains:

| Field | Meaning |
| --- | --- |
| `name`, `version` | Configured name and the running build revision |
| `edition`, `basePath` | `community` and the compiled `/mikka` mount |
| `desktopProtocol` | Supported range, currently `{ "min": 0, "max": 1 }` |
| `signIn` | Actual availability of `google`, `github` and `email` |
| `minDesktopVersion` | Valid `MIN_CLIENT_VERSION`, or `null` |
| `cloud.connected` | Optional cloud connection state; initially `false` |
| `mobileReady` | Whether the effective auth configuration trusts `mikka://` |

Email and password sign-in use this server's own accounts. Configure the email
sender described above for account verification and password reset. Google and
GitHub are optional; methods without a complete configured OAuth client are not
advertised. With `GITHUB_SIGN_IN_USE_APP=true`, discovery reads the initialized
GitHub provider so a manifest-managed deployment App is reported correctly.

For Google, create a **Web application** OAuth client in your own Google Cloud
project, configure its consent screen/audience, and add this exact authorized
redirect URI: `https://mikka.example.com/mikka/api/auth/callback/google`. Store
its client ID and secret as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
[Google documents the web-server OAuth setup and exact redirect matching](https://developers.google.com/identity/protocols/oauth2/web-server).

For GitHub, register your own OAuth App, set its homepage to
`https://mikka.example.com/mikka`, and set the authorization callback URL to
`https://mikka.example.com/mikka/api/auth/callback/github`. Store its client ID
and secret as `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.
[GitHub documents OAuth App registration](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app).
These values configure sign-in; repository access uses the deployment's GitHub
App described below. Recreate the app container after changing configuration.

The desktop opens the system browser on your server. After sign-in, your server
returns a one-time code to `http://127.0.0.1:<port>/auth/callback` on the same
computer. The desktop exchanges that code and its retained PKCE verifier with
the same server. No desktop callback registration is needed in Google or
GitHub: their registered callback is the server URL above. The loopback receives
a code, never a session token; the `mikka-auth://` link only brings the app to
the foreground. No polling is used for this handoff.

Community servers reject `BETTER_AUTH_OAUTH_PROXY_URL` and
`BETTER_AUTH_OAUTH_PROXY_SECRET`; leave both unset. OAuth must return to your own
registered client and server. `BETTER_AUTH_URL` must be the public **origin**,
for example `https://mikka.example.com`, without `/mikka`. An invalid origin
fails startup with `SELF_HOSTED_ORIGIN_INVALID` before database migration.

Realtime updates use the server's built-in gateway. Allow WebSocket upgrades
for `/mikka/v1/live/<channel>/socket` and the device gateway paths through your
reverse proxy. Authenticated `/api/live/ticket` responses contain the actual
socket address; keep the base path when validating or opening it. See
[self-hosted realtime and scheduling](self-hosting-realtime.md) for replica and
external-Worker configuration.

For iOS readiness, explicitly add `mikka://` to `AUTH_TRUSTED_ORIGINS` on a
community server. This exact scheme is supported; arbitrary custom schemes or
lookalike origins are refused. Official cloud deployments retain their existing
mobile trust. This flag reports sign-in readiness, not push-relay availability.

| Symptom | What to check |
| --- | --- |
| Server update requested | Discovery is missing, or `desktopProtocol.max` is below the app's supported protocol. Upgrade the server image. |
| App update requested | `desktopProtocol.min` or `minDesktopVersion` requires a newer app. HTTP `426` uses `desktop_client_update_required`. |
| Google `redirect_uri_mismatch` | Compare the registered callback, public HTTPS origin and `/mikka/api/auth/callback/google` exactly. |
| GitHub/Google button absent | Configure both fields for that provider, or explicitly enable the deployment GitHub App sign-in option. |
| `SELF_HOSTED_OAUTH_PROXY_UNSUPPORTED` | Remove hosted OAuth-proxy settings and use your own OAuth client. |
| Sign-in returns to an error page | Check origin/callback configuration and finish the one-time handoff before it expires; start a new login after a failed exchange. |
| Login works but realtime does not | Preserve the configured Host and allow the base-path WebSocket upgrade through the reverse proxy. |

## Models, computers, and GitHub

In **Settings → Models and subscriptions**, add your own provider API key, or connect your own Claude or ChatGPT subscription after configuring the subscription backend below. The community edition does not reserve Mikka credits, require a payment card, or stop after the hosted free-message allowance. It hides the Billing settings section. The normal user/workspace permissions and model access rules still apply.

To supply the server's default OpenAI-compatible model, set `MIKKA_DEFAULT_MODEL_BASE_URL`, `MIKKA_DEFAULT_MODEL_API_KEY`, and `MIKKA_DEFAULT_MODEL_ID`. Use the provider's API base, including its version path where required. Provider charges go to your account. Without a configured default model, choose one of your own available models.

Connect your own computer or server using the commands shown in Mikka's **Devices** settings. Copied commands always include `--server` with the current origin and `/mikka` path. The daemon's standalone CLI keeps its existing official-server default, so retain the flag for a self-hosted installation.

For an E2B cloud computer, save your own E2B key in your account. This does not buy Mikka-hosted compute and does not charge Mikka credits.

GitHub repository access uses your deployment's GitHub App. Manual configuration uses `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_CLIENT_ID`, and `GITHUB_CLIENT_SECRET` as required by the integration. The installation link is derived from the configured slug. It never sends a community user to the official Mikka App by default. The current OAuth configuration also enables GitHub sign-in; keep its callback registered on your own origin.

### Subscription backend prerequisites

Subscription connections use your own Infisical project or self-hosted Infisical instance to hold provider OAuth grants. PostgreSQL stores their metadata and references. A Mikka account or connection to Mikka cloud services is not required. The `CREDENTIAL_MASTER_KEY` used by the password vault does not configure subscription storage, and an existing Claude Code or Codex login on a machine is not imported into the server.

The Linux x64 Docker build includes the pinned `mikka-subscription-worker` and `mikka-subscription-enrollment` binaries. It sets their paths through `MIKKA_BYOS_WORKER_BINARY` and `MIKKA_BYOS_ENROLLMENT_BINARY`; keep those image defaults. A non-Docker build must run `MIKKA_BUILD_BYOS_WORKER=1 node scripts/build-subscription-worker.mjs` before `pnpm build:app` with the same variable set, so packaging rejects missing binaries. The build verifies the existing Go compiler checksum and CPA source commit and does not use provider or Infisical credentials.

Configure these server-only variables with values from **your own** Infisical installation. The standard two-identity configuration is:

| Variable | Required value |
| --- | --- |
| `MIKKA_BYOS_INFISICAL_ORIGIN` | The HTTPS origin of your Infisical service, without a path, query or fragment. |
| `MIKKA_BYOS_INFISICAL_PROJECT` | Your Infisical project ID. |
| `MIKKA_BYOS_INFISICAL_ENVIRONMENT` | Your environment slug. |
| `MIKKA_BYOS_INFISICAL_PATH` | The dedicated path holding provider grants and OAuth state, for example `/mikka/subscription-grants`. |
| `MIKKA_BYOS_ACCESS_INFISICAL_PATH` | A different path for access-only projections, for example `/mikka/subscription-access`. |
| `MIKKA_BYOS_CUSTODY_CLIENT_ID` / `MIKKA_BYOS_CUSTODY_CLIENT_SECRET` | Your Universal Auth custody identity, with read/create/delete permission on both paths. |
| `MIKKA_BYOS_ACCESS_CLIENT_ID` / `MIKKA_BYOS_ACCESS_CLIENT_SECRET` | A different Universal Auth identity, with read-only permission on the access path and no access to the grant path. |

The access path uses the same project unless `MIKKA_BYOS_ACCESS_INFISICAL_PROJECT` is set. The supported static-token alternative uses `MIKKA_BYOS_INFISICAL_TOKEN` for custody and a different `MIKKA_BYOS_ACCESS_INFISICAL_TOKEN` for access-only reads, with the same permissions. Do not mix in Mikka's project, identities, paths or provider grants. Supply these values as runtime secrets; the [environment template](../.env.example) lists the standard configuration.

After configuring this backend, each user connects their existing subscription through the normal provider OAuth flow in **Settings → Models and subscriptions**. Community defaults enable BYOS and both OAuth routes; an explicit administrator override can disable them. The owner, workspace permissions, model availability and quota are checked before use. Missing backend configuration is reported as unavailable and does not fall back to Mikka's credentials. The separate operator enrollment receiver has additional configuration; it is not required for the signed-in Settings connection flow. See the [subscription worker documentation](../packages/subscription-worker/README.md) for that custody boundary and recovery behavior.

The image acceptance check executes both packaged binaries and verifies their build digests, the worker's pinned CPA version, and rejection of an empty configuration. It makes no provider requests. A real Claude Code subscription task and a real Codex subscription task remain separate acceptance checks after OAuth authorization; the local synthetic model fixture does not establish either.

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
