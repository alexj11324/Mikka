# Self-hosting Mikka

Deploy the community server, then connect the official app to that server. It runs on your own database and does not need a Mikka account, Stripe, Vercel, Cloudflare, or a Mikka-owned API key. Your subscriptions and API keys belong to you. Hosted Mikka billing is disabled in the community edition.

The image provides the server: API, realtime, daemon gateway, scheduling, migrations and BYOK. **Mikka has one official UI**, whose Web, Desktop and iOS clients connect to this server ([active One UI decision](design/decisions/2026-11-08-2133-one-ui.md)). The old built-in community workspace was retired; `MIKKA_COMMUNITY_UI=1` no longer re-enables it. The public image still serves server status, sign-in and account handoff pages, not a second workbench. Official UI screenshots are not copied into the public server image.

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

Open `http://localhost:3000/mikka` for server information. Compose starts only the app and PostgreSQL. PostgreSQL has no exposed host port. At each application start, the existing migrations run before the HTTP listener starts. An advisory lock serializes migrations across replicas. Workflow uses its local backend and stores its durable state in the app data volume.

The app port binds to `127.0.0.1` by default. For remote access, put a TLS reverse proxy on the host and set `BETTER_AUTH_URL=https://mikka.example.com`. The value is an **origin**, without `/mikka`, credentials, a query, or a fragment. Forward `Host` unchanged, support WebSocket upgrades, and forward the original HTTPS scheme. The server rejects conflicting forwarded hosts or schemes. HTTP is accepted only for a configured loopback origin; use HTTPS for a network deployment.

Forward both `/mikka/*` and the root `/.well-known/workflow/*` paths to this service; Nitro mounts its Workflow consumers at the origin root.

If you publish a different host port, set both `MIKKA_PORT` and the port in `BETTER_AUTH_URL`. Configuration takes effect when the container is recreated:

```sh
docker compose up -d --force-recreate app
```


## Managed PostgreSQL: Neon (recommended)

For operators who want a managed database rather than maintaining PostgreSQL on
their own Linux host, we **recommend [Neon](https://neon.com/)**. It provides
standard PostgreSQL with managed operations, connection pooling, database
branching, and recovery options. Mikka does **not** require Neon or a Neon
account: the bundled PostgreSQL Compose file above and other compatible
PostgreSQL providers remain supported. This recommendation covers the database,
not hosted Mikka compute, model credits, or access to any Mikka account.

Use the independent [`docker-compose.neon.yml`](../docker-compose.neon.yml)
from the **same Mikka release** as the application image. Unlike the default
Compose file, it launches **only the Mikka app** and does not create a local
PostgreSQL service. This is a fresh-installation procedure; changing an existing
installation's database URL does not migrate its data.

1. [Create a Neon project](https://console.neon.tech/) and choose a region close
   to your Linux host. Use a dedicated database/role for this deployment.
2. In the Neon **Connect** dialog, select the same branch, database and role
   twice. First copy the **pooled** connection string (the host includes
   `-pooler`); disable *Connection pooling* to copy the **direct** string.
   Keep the SSL parameters supplied by Neon. See [Neon's connection
   guide](https://neon.com/docs/connect/connect-from-any-app) and
   [pooled vs direct requirements](https://neon.com/docs/connect/connection-pooling).
3. Alongside `docker-compose.neon.yml`, create a private `.env` file.
   The values below are **placeholders**, not runnable credentials:

   ```dotenv
   BETTER_AUTH_URL=http://localhost:3000
   MIKKA_IMAGE=ghcr.io/alexj11324/mikka:latest
   MIKKA_DATABASE_URL=postgresql://YOUR_ROLE:YOUR_PASSWORD@ep-YOUR-ID-pooler.YOUR-REGION.aws.neon.tech/YOUR_DATABASE?sslmode=require
   MIKKA_DATABASE_URL_UNPOOLED=postgresql://YOUR_ROLE:YOUR_PASSWORD@ep-YOUR-ID.YOUR-REGION.aws.neon.tech/YOUR_DATABASE?sslmode=require
   ```

   Copy **both complete URLs** directly from your Neon console, including any
   additional TLS parameters it supplies. They must address the **same**
   database and role. The deployment maps `DATABASE_URL` to the pooled
   `MIKKA_DATABASE_URL`, as the bundled Compose deployment does. Never add
   either connection URL to source control, support messages or screenshots;
   run `chmod 600 .env`. Be aware that `docker compose config` expands
   variables and may print the credentials.
4. Start the app (not the bundled `postgres` service):

   ```sh
   docker compose -f docker-compose.neon.yml up -d --wait
   curl --fail-with-body http://localhost:3000/mikka/api/server
   ```

   A remote deployment still needs the HTTPS reverse proxy, `BETTER_AUTH_URL`,
   and WebSocket forwarding described above. Configure an email sender or
   your own OAuth provider before creating the first account. Continue with
   [server entry and initial account](#server-entry-and-initial-account).

**Why two connection URLs?** Regular requests can use Neon's PgBouncer
transaction pool; persistent `LISTEN` sessions and session-level advisory
locks **cannot**. Mikka's built-in realtime/device transport uses dedicated
direct PostgreSQL sessions, so `MIKKA_DATABASE_URL_UNPOOLED` must be the
non-pooler URL. The migration code also uses a direct connection. These are
ordinary PostgreSQL features, not Neon-specific services.
See [realtime and replica guidance](self-hosting-realtime.md).

**Operations and recovery:** Neon stores your database; the Compose `app-data`
volume still stores local encryption keys and Workflow state. Back up **both**
the managed database (using an independently verified recovery/export plan)
and the application volume. Neon branching/history retention is useful for
recovery but is not a substitute for your separate application-key backup.
Pin a published image revision before upgrades; run `docker compose -f
docker-compose.neon.yml pull` and `docker compose -f docker-compose.neon.yml
up -d --wait` after the backup. Never use `down --volumes` for an upgrade.
For an existing local installation, first plan an explicit PostgreSQL
`pg_dump`/`pg_restore` using **direct** connections and a stopped writer;
this guide does not perform data migration automatically.

Image CI checks the external Compose configuration offline, then starts the
published Compose file with a private environment file against an independent
PostgreSQL 17 database. The query role has no DDL privileges. The direct role
runs migrations, and the server API reads the migrated database using the
query role. The bundled PostgreSQL quickstart also runs the real daemon and
packaged desktop tests. These checks use isolated PostgreSQL. On a live Neon
deployment, also verify its TLS and pooler settings, signup, bot chat,
WebSocket updates and daemon work on your own origin.


## Server entry and initial account

`GET /mikka/api/server` is the public server-info contract. Opening the server in a browser shows its status, server address, and official client links. JSON clients receive the same public installation information. It includes the configured name/address, running version, client entry links, initial-account state and login-method configuration. A healthy response means the configured origin is valid and the auth-user existence query succeeded; it does not claim to have checked external providers, workers or every subsystem. A failed query returns HTTP 503 and `setup.state: unavailable`, never an empty-installation state.

On an empty database, `setup.state` is `required`. Configure SMTP/Resend or your own OAuth client, then use `setup.signUpUrl` to create the initial account. Registration uses the existing authentication flow and creates that person's workspace with the `admin` membership. There is no installation-wide administrator role and no special access to other people's workspaces. Existing installations report `ready`; upgrading does not assign a new administrator or alter existing accounts. Email/password being enabled is separate from the `emailDeliveryConfigured` flag, which reports configuration presence rather than a successful delivery test.

The server retains sign-in, sign-up, verification/reset, device authorization, OAuth consent, invitations and app handoff pages. GitHub linking keeps its existing account-confirmation surface. Ordinary navigation from these pages returns to the server entry.

### Connect an official client

Open the official Web app and choose **Change** on the sign-in screen or under account settings. Select **Self-hosted server**, enter the HTTPS address from `/mikka/api/server`, and continue to sign in on your server. The app lists saved accounts with their server addresses. Choose **Mikka Cloud** to return to the Cloud account. Official Desktop and iOS clients also accept a server address.

The public image contains the API, daemon integration, and the pages needed for sign-in, password recovery, invitations, consent, and app handoffs. Upgrading uses the existing database and installation keys. Remove `MIKKA_COMMUNITY_UI` from older Compose configurations.

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

## Connect an official app

Use a client with server selection. Enter the address shown on the server status page or returned by `GET /mikka/api/server`. The client checks protocol and minimum version compatibility before sign-in.

| Client | Entry and address requirement |
| --- | --- |
| Web | [Official app](https://app.aspectlylabs.com/mikka); the server address must use HTTPS, including local addresses. |
| Desktop | [Official releases](https://github.com/alexj11324/Mikka/releases/latest); HTTPS for network servers, HTTP loopback for a local server. |
| iOS | Use your existing official installation/invitation. No verified public download link is supplied in this release's server metadata; `clients.ios.url` is `null`. Configure the mobile trust scheme below. |

### Official web transport

The official browser discovers the exact server, then uses its own one-time PKCE handoff and bearer session. Server credentials stay in that browser; the official backend does not relay requests or store the self-hosted session. Discovery exposes `web.enabled` and protocol range 1. Set `MIKKA_OFFICIAL_WEB_ENABLED=0` to disable official-browser handoffs and existing cross-origin bearer access. The default exact allowed app URL is `https://app.aspectlylabs.com/mikka`; `MIKKA_OFFICIAL_WEB_URL` can select an explicit HTTPS deployment URL without wildcards. This does not widen cookie trusted origins.

### Official desktop transport

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

## Connect the official iOS app

Use an iOS release that includes server selection. Add the following to your
server's environment, then recreate the app container:

```dotenv
AUTH_TRUSTED_ORIGINS=mikka://
MIKKA_SERVER_NAME=Acme Mikka
```

Preserve any other explicitly trusted origins already needed by your deployment.
`GET /mikka/api/desktop/discovery` must now report `mobileReady: true`. This
enables the existing native sign-in return, not the cloud push relay.

On the sign-in screen, tap **更改 → 自托管服务器**, enter
`https://mikka.example.com/mikka`, and tap **连接**. A bare hostname is also
accepted and probes the root before `/mikka`. Verify the displayed name and
version, then tap **继续** and sign in with an account on this installation.
The app displays only the providers configured by this server. If it says
「请在服务器上允许 Mikka iOS」, check the exact `mikka://` trust setting.
An older server asks for a server update; an incompatible protocol or minimum
client version asks for an app update, using the desktop's error vocabulary.

Use HTTPS with a valid certificate reachable by the iPhone. `localhost` and
`127.0.0.1` mean the phone itself, so the development-only HTTP exception does
not make a computer's unencrypted LAN address acceptable. Preserve WebSocket
upgrades and the `/mikka` path through the reverse proxy, as described above.

In **设置 → 账号与服务器**, add or switch saved accounts. Each native account
keeps its own server, session and workspace in SecureStore. Mikka Cloud remains
available as the default choice, and switching back restores that account's
session. Sign-out affects the selected account only. The official app continues
to receive JavaScript updates through Mikka's official Expo project, regardless
of which server is selected.

Realtime chat works with the built-in server gateway without Mikka Cloud.
iOS remote push requires the separately configured cloud relay because the
official app's push credentials remain with Mikka. Push data names its server
and account so a notification cannot route into a different saved account.

## Models, computers, and GitHub

In **Settings → Models and subscriptions**, add your own provider API key, or connect your own Claude or ChatGPT subscription after configuring the subscription backend below. The community edition does not reserve Mikka credits, require a payment card, or stop after the hosted free-message allowance. It hides the Billing settings section. The normal user/workspace permissions and model access rules still apply.

To supply the server's default OpenAI-compatible model, set `MIKKA_DEFAULT_MODEL_BASE_URL`, `MIKKA_DEFAULT_MODEL_API_KEY`, and `MIKKA_DEFAULT_MODEL_ID`. Use the provider's API base, including its version path where required. Provider charges go to your account. Without a configured default model, choose one of your own available models.

Connect your own computer or server using the commands shown in Mikka's **Devices** settings. Copied commands always include `--server` with the current origin and `/mikka` path. The daemon's standalone CLI keeps its existing official-server default, so retain the flag for a self-hosted installation.

For an E2B cloud computer, save your own E2B key in your account. This does not buy Mikka-hosted compute and does not charge Mikka credits.

Official images carry the public source commit and worker digest needed to add
Mikka to E2B's original `desktop` template. They contain no E2B key or task
credentials. If you build the image from source, pin both build inputs to the
same committed revision before using a cloud computer:

```sh
docker build \
  --build-arg MIKKA_BUILD_REVISION="$(git rev-parse HEAD)" \
  --build-arg MIKKA_BUILD_WORKER_SHA="$(python3 scripts/e2b/build-template.py --worker-hash --source-ref HEAD)" \
  --tag mikka-self-hosted .
```

The revision must be available from the official source repository because the
additive E2B installer fetches that exact commit and verifies its worker digest.
An operator-supplied runtime release still uses the existing
`MIKKA_CLOUD_WORKER_SOURCE_COMMIT` and `MIKKA_CLOUD_WORKER_SHA` checks.

## Create your GitHub App

GitHub repository access uses an App that you own. Mikka generates its registration form locally and sends your browser to GitHub; it does not contact Mikka Cloud or fetch the official App's configuration at runtime.

1. Sign in to your self-hosted Mikka account. In that browser, open `/mikka/api/auth/get-session` on your server and copy your own `user.id` from the response. Keep the response private; it also describes your session.
2. Add `MIKKA_SERVER_ADMIN_USER_IDS=<your-user-id>` to the server environment, then recreate the app container. Multiple IDs are separated by commas. Only the server operator can appoint administrators. The first registered user and workspace administrators receive no automatic server authority.
3. Open **Plugins → GitHub → Server GitHub App → Create GitHub App**. Choose your personal GitHub account, or enter an organization you administer. GitHub asks you to confirm creation and the requested permissions.
4. GitHub returns to your server, which exchanges the one-time code and stores the App credentials. Select **Authorize repositories** to install your App on the repositories you choose, then **Link GitHub** to connect your account.

Use a public HTTPS origin in `BETTER_AUTH_URL`; GitHub must be able to reach the webhook. All callback, setup and webhook URLs include the deployment base path. The app is private (`public: false`), so installation is limited to its owning personal account or organization. The permission and event template is versioned with the code; see [GitHub App manifest](github-app-manifest.md).

The state expires after one hour, is stored only as a hash and is bound to the administrator's user ID, current session and exact origin. The callback checks those bindings and the browser cookie again before exchanging the code. Signing out, changing accounts, removing administrator access, or reusing a callback prevents registration. Starting again replaces that administrator's earlier pending setup. A completed registration cannot overwrite an already configured App.

The six returned fields—App ID, slug, private key, webhook secret, OAuth client ID and OAuth client secret—are encrypted together in `server_github_app` with `WORKSPACE_SECRETS_KEY`. Only the App slug and installation link are shown in settings. Keep the database and installation keys in the same backup plan. A missing or incorrect encryption key fails explicitly; it never silently selects another App.

Repository linking, installation links, token refresh, installation checks, webhook verification and webhook redelivery read the saved App immediately. Existing manual installations remain supported: if no App has been saved in the database, the server reads `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. Remove an incomplete manual App configuration before starting the creation flow. The community installation link never defaults to the official Mikka App.

### Reuse the App for sign-in

Repository linking works independently of the Mikka sign-in method. By default, GitHub sign-in continues to use the separately configured `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, so the official cloud's existing login configuration is unchanged.

To use your newly stored App for GitHub sign-in too, set `GITHUB_SIGN_IN_USE_APP=true` after creating it and restart the app container. Better Auth initializes provider options once, so this choice requires a restart. Its callback is already in the generated manifest. Keep another working sign-in method while making the change; changing the GitHub OAuth application can require existing users to sign in again or link their GitHub account. Disabling App sign-in restores the environment-configured OAuth client on the next restart; it does not remove repository connections or App credentials.

### Subscription backend prerequisites

Subscription connections use your own Infisical project or self-hosted Infisical instance to hold provider OAuth grants. PostgreSQL stores their metadata and references. A Mikka account or connection to Mikka cloud services is not required. The `CREDENTIAL_MASTER_KEY` used by the password vault does not configure subscription storage, and an existing Claude Code or Codex login on a machine is not imported into the server.

The Linux x64 Docker build includes the pinned `mikka-subscription-worker` and `mikka-subscription-enrollment` binaries. It sets their paths through `MIKKA_BYOS_WORKER_BINARY` and `MIKKA_BYOS_ENROLLMENT_BINARY`; keep those image defaults. A non-Docker build must run `MIKKA_BUILD_BYOS_WORKER=1 node scripts/build-subscription-worker.mjs` before `pnpm build:server` with the same variable set, so packaging rejects missing binaries. The build verifies the existing Go compiler checksum and CPA source commit and does not use provider or Infisical credentials.

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

An existing usable custody identity can also serve the shared-custody mode.
Set `MIKKA_BYOS_SHARED_CUSTODY_IDENTITY=1` with its custody client ID/secret and
the two distinct storage paths. The application authorizes the exact binding,
consumer, run and membership before reading an access-only projection. This
mode keeps the custody identity on the application side. Use the existing
authorized configuration described in the [subscription worker guide](../packages/subscription-worker/README.md).

After configuring this backend, each user connects their existing subscription through the normal provider OAuth flow in **Settings → Models and subscriptions**. Community defaults enable BYOS and both OAuth routes; an explicit administrator override can disable them. The owner, workspace permissions, model availability and quota are checked before use. Missing backend configuration is reported as unavailable and does not fall back to Mikka's credentials. The separate operator enrollment receiver has additional configuration; it is not required for the signed-in Settings connection flow. See the [subscription worker documentation](../packages/subscription-worker/README.md) for that custody boundary and recovery behavior.

The image acceptance check executes both packaged binaries and verifies their build digests, the worker's pinned CPA version, and rejection of an empty configuration. It makes no provider requests. A real Claude Code subscription task and a real Codex subscription task remain separate acceptance checks after OAuth authorization; the local synthetic model fixture does not establish either.

## Edition and hosted deployment

`MIKKA_EDITION` is read at runtime through `lib/edition.ts`. Its default is `community`; the only other accepted value is `cloud`. Invalid values fail configuration rather than silently choosing a billing mode. The same image can be used with a new origin without rebuilding its browser assets.

Official Mikka Cloud production must explicitly set the non-secret `MIKKA_EDITION=cloud` selector in the trusted release build and deployed runtime. The legacy Vercel deployment retains the corresponding Vercel Production value while it still serves; the target Cloudflare release uses its own verified container and secret bindings instead. The release job declares its build value and verifies the matching Vercel value; credentials still come from Infisical. Its Stripe checks, trial limits, reservation/settlement, and existing providers remain enabled. The previous domain redirect is separately configured with `MIKKA_LEGACY_APP_HOST`; it grants no authenticated access through the old host.

Optional Mikka cloud services are a separate connection. The community edition remains usable without connecting them. The hosted-compute resale option is not included; its pricing decision is tracked separately in #1569.

## Build, verify, and upgrade

Build the public application from a checked-out revision:

```sh
docker build --build-arg MIKKA_BUILD_REVISION="$(git rev-parse HEAD)" -t mikka:local .
MIKKA_IMAGE=mikka:local docker compose up -d --wait
node scripts/self-hosted-smoke.mjs
```

The build uses the pinned pnpm lockfile, Vite frontend, Nitro Node server, and Node 24. It does not run migrations at image build time and does not require production credentials. `.dockerignore` excludes local environment files and private hosted UI. The runtime image contains the traced server dependencies and public assets, runs as an unprivileged user, and starts from its standalone output directory.

The **Self-hosted image** workflow builds the image, starts a clean PostgreSQL 17 database, checks migrations/startup health, verifies public configuration and static assets, and restarts the same persisted installation. A successful main build publishes `ghcr.io/alexj11324/mikka:<commit-sha>` and updates `latest`; release tags publish matching tags. Pin the SHA or release tag in `.env` before an upgrade, back up the two volumes, then run `docker compose pull` and `docker compose up -d --wait`. For a stable versioned release, use the [host-only upgrade controller and compatibility policy](self-hosted-updates.md); main/`latest` image publication never restarts existing self-hosted servers automatically.

`/mikka/api/version` reports the compiled revision. `docker compose ps` reports health. Startup logs include migration names and bounded error codes, never generated installation keys.

## Optional Mikka Cloud services

The server works without a Mikka account. For optional official GitHub, iOS push and hosted models, set `MIKKA_SERVER_ADMIN_USER_IDS` to the explicit local administrator IDs and use Settings → Mikka Cloud. Each person binds their own cloud account under Settings → Account, or the administrator supplies a team server key. The account settings show which credits apply. See [the public API contract](cloud-services-api.md).

See [BYOK services](self-hosting-byok.md) for SMTP, S3, local vault and default-model configuration, and [builtin realtime](self-hosting-realtime.md) for multi-instance operation.

A public checkout selects the server-only renderer for `pnpm build`, `pnpm build:app` and `pnpm --filter @mikka/frontend build`. Official Web and Desktop builds require a separate private Git checkout and its matching revision. Public CI explicitly requests `--public-test-fixture` for the unlicensed renderer used by the existing loopback and package tests. Its manifest identifies it as a test fixture.
