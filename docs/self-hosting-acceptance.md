# Self-hosted image acceptance

The `Self-hosted image` workflow builds the exact GitHub checkout once and uses
that image for two independent Node application processes. Both connect to one
disposable PostgreSQL 17 service. Each application has its own data volume;
the test supplies the same temporary installation keys to both. The ordinary
two-service user Compose file stays unchanged. CI adds
`tests/self-hosted/compose.services.yml` and removes all its containers and
volumes in the final step.

No Infisical identity, Mikka account, cloud-provider key, browser, or paid cloud
computer is used. The driver runs inside the application container and refuses
production origins, remote databases, Mikka cloud credentials and external model
targets before issuing a write.

## Checks in the deployed application

| Flow | Evidence required for a pass |
| --- | --- |
| Email signup and recovery | A new user registers through Better Auth. Mailpit receives the verification and password-reset emails from the configured sender. Both links are redeemed and the replacement password signs in to a verified account. |
| S3-compatible storage | An authenticated chat attachment uploads through the application into MinIO. The application returns a Signature V4 download URL, its bytes match the original UTF-8 file, and the same object without its signature refuses anonymous access. |
| Built-in live, two replicas | A real owner/workspace ticket opens a WebSocket on application 1. Creating a bot through application 2 produces the workspace's bot-list invalidation on that socket through shared PostgreSQL. No Cloudflare variables are configured. |
| Community chat | The created bot accepts 31 serial user messages and completes 31 corresponding replies through a local OpenAI-compatible fixture. The test waits for live events between reads. That workspace has no `hosted_usage` rows. |
| Image and restart | The existing smoke verifies exact revision, community discovery/config, sign-in HTML and compiled assets, then repeats after restarting the persistent installation. |

The retained `self-hosted-services-<revision>` artifact contains only the exact
revision, fixed local origin, check outcomes and counts. It excludes user email,
cookies, passwords, email contents, tokenized links, object URLs and provider
input. A failed stage emits a closed error code; it never dumps a raw provider
or authentication response.

The local model is explicitly reported as `synthetic-openai-compatible`.
These results prove the configured HTTP/streaming protocol, local Workflow
execution and community metering boundary. They do not prove real Claude Code
or Codex subscriptions, model quality, a native daemon task, or production
hosted billing. Those remain separate acceptance cases. The desktop discovery
and backend handoff suites also do not substitute for the packaged desktop
application and real Google login required by #1556/#1557.

## Existing Mikka cloud compatibility

The separate `Mikka cloud core compatibility` workflow starts after a
successful main `Web deploy`. Its real `workflow_run` guard verifies the exact
current main commit, the public `/mikka/api/version`, the completed publication
job and its cloud-edition/build/upload/version steps. It runs only while at
least one of #1560, #1561, #1562 or #1556 remains open. An all-closed result is an
explicit skip, before owner credentials; a stale or unproven target cannot
start the business checks. The target is checked again after cleanup.

This job accepts compatibility of the already-deployed Mikka cloud application.
The independent `Self-hosted image` workflow above accepts the community
deployment. A passing cloud compatibility report does not complete that
community deployment's registration, chat or daemon-task acceptance.

The existing GitHub OIDC identity delivers only `SMOKE_OWNER_EMAIL` and
`SMOKE_OWNER_PASSWORD` from `prod:/`. GitHub's built-in read-only job token reads
release and issue metadata. No Vercel, Worker, database or provider credential
is delivered to this driver, and no identity or trust policy is created.

| Production check | Evidence required |
| --- | --- |
| Edition and desktop discovery | The live discovery reports the accepted build, `cloud`, the current protocol range, login-method booleans, mobile readiness and the cloud-connection boolean. |
| Normal account and flags | The existing owner signs in, selects the authorized shared team through ordinary membership checks, and reads its own desktop bootstrap. Cloud computer availability remains on; computer-time billing and its tab kill switch remain off. |
| Read-only billing configuration | An administrator can read `billing.getBilling` and requires Stripe to remain configured. A team member is reported as `not_authorized`; the driver never elevates that account. Hosted usage and card-status readers are excluded because they can perform legacy verification writes. |
| Existing Worker live channel | A ticket for the device reader's actual owner/personal-workspace scope opens the existing gateway, receives `live_ready`, and receives `device_list` when this attempt registers its new device. Selecting a team does not substitute the team ID for that owner channel. |
| Source daemon HTTP and gateway | The repository's real `HttpServerLink` performs enrollment, registration, disabled scheduling and heartbeat. Its own device ticket opens a WebSocket and exchanges `ping`/`pong`. No harness or OS service is installed. |
| Exact cleanup | Both sockets close; only the newly identified credential is revoked; the original credential receives the client's typed 401; only the nonce device is removed after normal offline expiry. Existing devices and credentials retain their original state, and the run closes its own login session. |

This is bounded API/CLI transport acceptance. It sends no model request, starts
no cloud computer, accesses no database directly and runs no browser or OAuth
flow. It does not establish quota/card enforcement, a billing settlement,
native desktop UI behavior or a daemon task. Those claims remain separate.

The closed report records deployment/run identity, capability booleans,
cleanup checks and explicit coverage boundaries. It contains no raw account,
device, billing, provider or WebSocket response, ticket, credential or cookie.
The job log and step summary retain that report; optional artifact retention
does not hide a business failure or turn a storage-quota failure into lost
evidence. Offline guards and a real disposable loopback WebSocket test run on
pull requests before the production entry can reach main.

## Fixture provenance

Mailpit uses the official `axllent/mailpit:v1.27.4` image and its documented
[message-event WebSocket](https://mailpit.axllent.org/docs/api-v1/websocket/)
and [message API](https://mailpit.axllent.org/docs/api-v1/). Version checking
and reverse DNS are disabled; SMTP messages never leave the fixture.

MinIO's [community distribution is source-only](https://github.com/minio/minio/blob/9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a/README.md).
CI therefore builds its official
[RELEASE.2025-10-15T17-29-55Z](https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z),
fixed to commit `9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a`, with Go 1.24.8.
It does not depend on a moving third-party mirror or install a storage service
on any existing server. The resulting image is a disposable test fixture;
only the tested Mikka application image is published.
