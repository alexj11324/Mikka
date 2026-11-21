# Artifact sharing defaults and access

Use this contract when connecting a share control to the backend. The existing
share action creates a link with a fixed scope; workspace settings choose that
scope only when the caller omits it. Thread sharing is owned by #2936 and does
not use the artifact writer.

## Create a link

Call `shareArtifact(artifactId, visibility?)` through the existing server action
or desktop RPC action `artifacts.shareArtifact`. The optional second argument
is `private`, `workspace`, or `link`. The server validates both arguments again.
The caller must own the artifact and remain admitted to its actual workspace.
Workspace membership alone cannot create a link to another member's artifact.

The return type is `CreatedArtifactShare` from `@mikka/protocol/artifact-share`:

```ts
{
  token: string
  scope: {
    visibility: 'private' | 'workspace' | 'link'
    workspaceId: string
  }
  source: 'explicit' | 'workspace' | 'default'
}
```

`explicit` means the caller supplied the second argument for this link. It does
not create a personal setting. If the argument is absent, the artifact's
workspace `artifactShareVisibility` value supplies the scope and source. The
registry default is `link`, preserving the existing sharing behavior. The
workspace settings read still returns `{ value, source }` under the standard
settings contract, with source `workspace` or `default` for this field.

The token is returned once and stored only as a hash. Changing or resetting a
workspace default leaves existing links unchanged. Use
`stopSharingArtifact(artifactId)` to revoke every live link to the artifact.

## Read a link

Both existing GET routes apply the same share reader:

- `/api/artifacts/shared/:token` returns artifact metadata and Markdown content.
- `/api/artifacts/shared/:token/frame` returns the sandboxed HTML document.

The token must identify an unrevoked share whose issuer still owns the artifact
and passes the existing workspace and Enterprise admission checks. Restricted
links add the following viewer checks:

| Visibility | Viewer requirement |
| --- | --- |
| `private` | A current session for the share creator and current admission to the artifact's workspace. |
| `workspace` | A current session and active membership in the artifact's workspace, including Enterprise policy checks. |
| `link` | Possession of the link; anonymous reads retain their existing behavior. |

The server derives the viewer from the verified browser or native session.
Request body, query parameters, and a supplied user ID cannot choose a viewer.
Restricted links bypass the session cookie cache. Public links do not require
a session read. The selected workspace in the viewer's UI does not redirect
the link to another tenant.

Missing, revoked, inaccessible, malformed, and deleted shares return `404`.
Metadata preserves the existing response shape. HTML bytes are returned only
by the frame route, with its existing sandbox and content security policy.
Both routes use `Cache-Control: private, no-store`, including denied frames, so
new requests cannot reuse a cached response after access changes.

## Storage and migration

`20261120193615_artifact_share_visibility.sql` adds the typed
`artifact_shares.visibility` column with default `link` and a database check for
the three supported values. Existing rows become `link`. The migration does
not change tokens, creators, artifact IDs, timestamps, or revocation state and
can execute repeatedly without overwriting an explicit scope.

Creation holds workspace admission and an artifact row lock through the share
insert. Settings reads, the share insert, and live notification registration use
the same application transaction, including with a single database connection.

## Rollback

Keep the additive column. A backend that ignores visibility would expose a
private or workspace link as a public bearer link. Before rolling back to such
a reader, revoke every live share whose visibility is not `link`, or keep this
reader's visibility checks in the rollback release. Do not convert restricted
rows to `link` or drop the column as a rollback shortcut. Revoked tokens stay
revoked; creators can create replacement links after the corrected release.

The PostgreSQL owner test is
`tests/artifact-share-visibility.db.test.ts`. It exercises the actual share
actions, both HTTP readers, stored defaults, owner and tenant refusals, member
and issuer revocation, and an upgrade fixture that executes the exact migration
twice. It uses the repository's synthetic session fixture and real isolated
PostgreSQL; it does not claim live provider authentication or deployed browser
acceptance.
