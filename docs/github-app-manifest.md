# Self-hosted GitHub App registration

## Staging checkpoint — #1563 is not ready for acceptance

The encrypted configuration, administrator boundary, Manifest registration
flow, existing GitHub readers and settings UI are implemented. The static
permissions/events snapshot still needs the official App's authenticated
metadata. `lib/github/manifest-template.ts` deliberately contains `null` at
this checkpoint: registration returns the `template` error before storing
an intent or opening GitHub. Do not treat this checkpoint as completed
one-click registration or merge it as the final #1563 result.

Anonymous `GET /apps/mikka-github` returned 404. That does not establish
whether the App exists; a private App is not available through that lookup.
The read-only CI probe found no `GITHUB_APP_ID` or `GITHUB_APP_PRIVATE_KEY`
named secrets at Infisical `prod:/vercel`. The existing Vercel deployment
identity can select their production environment entries, but those reads
have not returned usable credential values. Neither result is permission
to change identity, reveal credentials, or guess the App's permissions.

## Obtain the public metadata once

An explicitly appointed server administrator with a fresh session can read:

```text
GET /mikka/api/github/manifest?metadata=1
```

This signs a short-lived App JWT in server memory and only calls the fixed
`https://api.github.com/app` endpoint. It returns the validated App slug,
permission names/access levels and event names. It never returns the JWT,
private key, webhook secret, client secret, raw provider response, or an
arbitrary URL. Other users receive only their non-admin status and no
provider request is made. This is an explicit administrator operation, not
part of application startup or ordinary GitHub calls.

Record the revision, deployment origin and read time, copy that public
projection into `GITHUB_APP_MANIFEST_TEMPLATE`, cite its source here, and
remove this staging notice and the temporary `template` error. A new
self-hosted server must create its App entirely from that bundled snapshot
without reading Mikka or the official App at runtime.

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
endpoints, account-scoped settings and fresh-session reads. This cloud
workspace has no PostgreSQL binary, so the real database suite must run in
the existing CI PostgreSQL environment before acceptance can be claimed.

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

Remaining acceptance after the verified snapshot lands: real App creation
on a public HTTPS self-hosted instance without `GITHUB_APP_*` environment
variables; installation on a test repository; clone/push/PR and signed
webhook/merge behavior; existing cloud App behavior; production-build UI
screenshots at desktop/narrow widths and light/dark themes. Unit mocks and
the pending PostgreSQL suite are not evidence of real GitHub acceptance.

Protocol reference: [GitHub App Manifests](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).
