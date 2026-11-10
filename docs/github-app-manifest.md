# Self-hosted GitHub App registration

## Verified official App snapshot

One-click registration uses the bundled permissions/events in
`lib/github/manifest-template.ts`. The existing OIDC/Infisical Actions
[run 42369222955](https://github.com/alexj11324/Mikka/actions/runs/42369222955/job/128393675936)
read the official `mikka-github` App at `2026-11-07T11:43:44.314Z` with authenticated
`GET https://api.github.com/app`. Workflow source: `ec4a331a`, using the existing
identity and named App credentials in `prod:/github`. Only public metadata was
recorded; credentials and the signed JWT remain in the runner. Anonymous lookup
404 and personal GitHub token 401 do not replace this authenticated snapshot.

The exact permission snapshot is:

| Permission | Access |
| --- | --- |
| `actions` | write |
| `administration` | read |
| `checks` | read |
| `contents` | write |
| `deployments` | read |
| `discussions` | write |
| `emails` | read |
| `gists` | write |
| `issues` | write |
| `members` | read |
| `merge_queues` | read |
| `metadata` | read |
| `organization_projects` | write |
| `pull_requests` | write |
| `repository_advisories` | read |
| `repository_custom_properties` | read |
| `repository_projects` | write |
| `secret_scanning_alerts` | read |
| `security_events` | read |
| `starring` | write |
| `statuses` | read |
| `vulnerability_alerts` | read |
| `workflows` | write |

Events: `deployment_protection_rule`, `issues`, `issue_comment`, `pull_request`, `pull_request_review`, `pull_request_review_comment`.

A new self-hosted server creates its private App entirely from this bundled
snapshot, without reading Mikka or the official App at runtime. The server-admin
metadata endpoint remains an explicit read-only operation; it is not a runtime
registration dependency. Existing cloud App configuration remains unchanged.

## Behavior and validation

The registration form is posted by the browser to GitHub's personal or
organization App creation page. GitHub calls back to the exact configured
origin and base path. A hashed, one-hour state is bound to the current user,
session and origin and atomically consumed before exchanging the code.
`server_github_app` accepts only one encrypted credential payload. A second
administrator or replay cannot replace it. The encryption is authenticated
and bound to this singleton configuration. Database and decryption errors
fail explicitly instead of selecting another App.

The production handlers are exercised by
`tests/github-app-manifest.db.test.ts` in the existing required
`test:github-connections-db` suite. Its separate schema keeps the singleton
fixture from affecting concurrently running database suites. Local source
tests cover encryption, origin and organization validation, fixed provider
endpoints, account-scoped settings and fresh-session reads. The original implementation workspace could not run PostgreSQL. That
constraint records its evidence boundary. New database validation uses the
isolated CI PostgreSQL environment, and new runtime evidence follows
[acceptance](acceptance.md).

UI reuse: `SettingsSection`, `SettingRow`, `AppTile`, `Button`, `Dialog`,
`FieldGroup`, `Field`, `FieldLabel`, `Input`, `Select`, `Alert` and `FieldError`.
No primitive was added. The section hides for non-admins and unconfirmed
sessions; its initial read does not poll or repeat on focus. The desktop
hands setup to the system browser, as the existing GitHub linking flow does.

| Operator task | Before | Implemented behavior |
| --- | --- | --- |
| Assign server authority | No instance-wide administrator boundary | Explicit user ID allowlist; signup and workspace roles grant none |
| Create an App for a personal account or organization | Manual App setup and environment copying | Existing settings controls collect ownership; browser posts the bundled manifest to GitHub |
| Return after account/session change or timeout | No Manifest flow | Refused before code exchange; retry starts a new intent |
| Use the newly saved App | Environment-only readers | Connection, installation, repository checks, webhook and redelivery use the encrypted database App immediately |
| Reuse the App for sign-in | Separate OAuth environment client | Explicit opt-in, activated on restart; existing cloud sign-in remains the default |

Remaining real acceptance: real App creation
on a public HTTPS self-hosted instance without `GITHUB_APP_*` environment
variables; installation on a test repository; clone/push/PR and signed
webhook/merge behavior; existing cloud App behavior; production-build UI
screenshots at desktop/narrow widths and light/dark themes. Unit mocks and
the pending PostgreSQL suite are not evidence of real GitHub acceptance.

Protocol reference: [GitHub App Manifests](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).
