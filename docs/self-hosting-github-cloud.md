# GitHub through Mikka Cloud

An instance with its own GitHub App uses that App first. Otherwise a person's Mikka Cloud connection, or the administrator's team server key, can supply the official App's installation credentials. Without a cloud binding the existing environment-backed GitHub OAuth connection continues to work. A revoked or insufficient cloud binding is an error; it never silently switches account or billing authority.

## Installation and repository access

The GitHub settings page's existing install link calls the local authenticated `/api/integrations/github/install` endpoint. For a cloud connection, the server requests a one-use state from `POST /v1/github/install` and opens the returned GitHub installation URL. The official App's Setup URL stays `/mikka`: its landing route recognizes only the broker's `mikka-gh.<server UUID>.<opaque>` state and redirects to the same origin's `/mikka/cloud/v1/github/setup`. Ordinary official installations without that state keep the existing homepage landing. The callback checks the cloud browser session, the authorized workspace, and that person's existing GitHub identity before binding the installation to the server, subject and credential. A personal account must belong to that GitHub user. An organization requires a current organization administrator; merely being able to read a repository is insufficient to delegate an entire installation. The existing App's user permissions must permit the GitHub membership read. Failure is reported, not replaced by inferred ownership.

The state expires after ten minutes and can be consumed once. An installation already associated with another server or credential cannot be claimed by a redirect. The redirect back is fixed to the registered server origin, base path and GitHub settings page.

Repository discovery obtains an installation token and reads GitHub directly. Local tables cache non-secret installation and repository identities for selection; they do not authorize token issuance. The cloud checks the live server, grant/key, subject, workspace and installation association each time it issues a new native token.

## Machine credentials and publication

`githubMachineCredential` is the preparation and renewal entry point. It asks the cloud for the run's server-selected installation and repository, receives GitHub's real token, and places that token in the existing claim response. The daemon's existing `prepareMachineGitHub` writes it to the machine's normal `gh/hosts.yml` and uses the actual `gh auth git-credential` helper. Git and gh connect straight to GitHub. No command receives a placeholder token or makes an authorization trip through Mikka.

The existing daemon schedules renewal thirty seconds before the native token expires. The same run/device ownership checks authorize the renewal; the repository must still match the run. The new response replaces the native credential file atomically. Native tokens expire in approximately one hour. The broker permits at most 5,000 issuances per registered server per UTC hour.

The publication path distinguishes the two types of authority. Existing personal user tokens still verify GitHub `/user` against the linked account. A cloud installation token checks that the repository is included in `/installation/repositories`; it does not pretend to be a human GitHub identity. PR creation, recovery after an uncertain response, the expected branch SHA, and the existing host write fence stay in place.

The Coordinator's official hosted GitHub MCP and a person's manual Factory merge continue to require that person's GitHub user token. Connecting this cloud capability does not enable those two identity-specific operations. The settings page describes repository access by agents and identifies the cloud connection; it does not advertise MCP or human merge authority.

## Webhook delivery

The official App's webhook URL remains `/mikka/api/webhooks/github`. Its existing business handling runs in the official public deployment, with that deployment's Workflow identity. Only `MIKKA_EDITION=cloud` with an explicitly configured `MIKKA_CLOUD_BACKEND_URL` enables a second, fixed server-to-server hop to `<backend>/mikka/cloud/v1/github/webhook`. The configuration is a plain HTTPS origin without a path, query, fragment or user information; callers cannot choose it. The relay sends only the original body, GitHub signature, event and delivery id, never a browser cookie or user bearer token, and refuses redirects.

An unset backend means this optional bridge has not been deployed. Once configured, a failed hop returns non-2xx to GitHub while keeping official business handling in its original runtime. The existing hourly GitHub delivery sweep retries failed deliveries for twenty-four hours and includes all App event types when the bridge is configured; its existing limit of twenty-five redelivery requests per run remains. There is no new polling loop. The private service does not import or execute the official site's business dispatcher.

The private cloud independently verifies GitHub's original `x-hub-signature-256`, then stores an encrypted delivery only for the associated self-hosted server. The body is forwarded unchanged to `<registered origin><base path>/api/cloud/webhooks/github`, with the original event and delivery id and:

```text
Mikka-Cloud-Signature: t=<unix seconds>,v1=<HMAC-SHA256(serverSecret, "t.body")>
```

The receiver checks the HMAC with the locally encrypted server secret and accepts a timestamp at most five minutes from its clock. A shared PostgreSQL receipt deduplicates delivery ids across replicas and rejects a reused id with a different event or body digest. Failed work releases its lease; a process crash leaves a bounded lease that a later retry can acquire. Receipts contain metadata and a digest, never the body. The verified handler is shared with `/api/webhooks/github`, so notifications, PR badges and Factory merge readback use the existing business logic. Forwarded deliveries acknowledge after that work completes.

Each outbound attempt resolves the registered public HTTPS origin again and pins the validated address to its TLS connection. Redirects are never followed. Failures retry exponentially, from ten seconds up to one hour between attempts, for up to twenty-four hours. The cloud erases the encrypted body when delivered, expired or cancelled.

## Disconnect and operation

A core revocation transaction removes the applicable installation associations, cancels pending webhooks and marks every applicable unexpired native token for revocation. The worker calls GitHub `DELETE /installation/token` with each actual token. A failed provider call stays in durable pending work and retries until revocation succeeds or the token expires. A provider mint racing a disconnect is recorded for disposal and is never returned to the self-hosted server.

The private deployment must register `githubRevocationHook` and provide the broker's durable wakeup adapter. It runs after a revocation commit, when a webhook is queued, on startup and at the exact next retry deadline. PostgreSQL NOTIFY alone does not recover a missed event after downtime. The production acceptance must observe native GitHub requests failing after revocation; rejection of a Mikka JWT alone is not that evidence.

## Validation status and remaining production gates

Source tests cover credential priority, native-token handoff, failure without account fallback, fixed GitHub endpoints, App JWT signing, installation-manager checks, HMAC tampering and expiry, SSRF rejection, and installation-aware publication. Existing machine credential tests cover native credential-file writes and natural-expiry renewal. PostgreSQL tests cover one-use setup, competing servers, atomic token quotas, a disconnect racing mint, encrypted outbox storage, delivery retries and deduplication; they require the isolated CI PostgreSQL services.

Live acceptance still requires the private cloud deployment with its existing official App credentials, verification of the existing official App setup/webhook URLs and the fixed bridge configuration, a publicly reachable non-production self-hosted instance, and a shared authorized test GitHub account/repository. Run clone, push, PR publication, notification and merge readback with both specified subscription paths, then disconnect and demonstrate native GitHub token failure. Record the exact public/private commits, deployment origins, CI runs and dispatch timing. Synthetic provider fixtures and a skipped local database suite are not production acceptance.
