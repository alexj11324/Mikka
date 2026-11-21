# Git and review settings

These fields extend the [registered settings writer](registry.md). They use
its field-specific guards, current membership checks, typed persistence,
inheritance, reset and machine-readable schema. Shared result types are in
`lib/code-review/settings-contract.ts`; generic setting results come from
`@mikka/protocol/settings`.

## Pull request defaults

| Key | Value | Product default |
| --- | --- | --- |
| `prTitlePrefix` | Text, at most 80 characters; no control characters | `""` |
| `prBranchPrefix` | Safe Git path prefix, at most 80 characters | `"mikka"` |
| `prAutoMerge` | Boolean | `false` |
| `prDraft` | Boolean | `false` |

The signed-in person can write an override for the selected workspace through
`PATCH /api/settings/personal?workspaceId=<uuid>`. A workspace administrator
can write defaults through `PATCH /api/settings/workspace/<uuid>`:

```json
{"values":{"prTitlePrefix":"[team]","prBranchPrefix":"team/changes","prDraft":true}}
```

The response contains the complete effective settings view. Each field has
`value` and `source`, for example:

```json
{
  "workspaceId": "00000000-0000-4000-8000-000000000001",
  "values": {
    "prTitlePrefix": { "value": "[team]", "source": "workspace" },
    "prBranchPrefix": { "value": "team/changes", "source": "workspace" },
    "prAutoMerge": { "value": false, "source": "default" },
    "prDraft": { "value": false, "source": "personal" }
  }
}
```

`null` removes that level's value: personal falls back to workspace, then to
the product default. Empty strings and `false` are explicit values. The
`git` reset group resets all four defaults through the existing reset routes.
Workspace reads omit personal overrides.

Local and cloud admission freeze the effective defaults on the run's
publication. A new task branch retains its issued task identifier, such as
`team/changes/mik-42`; an empty prefix produces `mik-42`. A later run on the
same task retains the existing publication branch. Changing the default
does not rename a task branch or change an admitted run's frozen defaults.
When the native Agent already opened the task's PR, publication adds a missing
non-empty title prefix to the current public title inside its normal write
authority check; it does not replace that title with private task prose.

Current daemons advertise custom-branch support in the existing claim
capability headers. Released daemons retain their ordinary `pushBranch`
assignment and native push path; the server omits the optional GitHub
delivery branch when that old parser cannot accept its prefix. The server
then publishes the PR through the same completion workflow. Repository
admission and signed workflow results keep the exact owner, workspace,
repository, task and branch binding.

Failed verification keeps the existing no-publication gate. Unverified
non-Factory submissions remain drafts. A saved draft preference always
keeps the PR a draft. Factory's existing treatment of unavailable commands,
independent review and evidence is unchanged.

Automatic merge requests use GitHub's native `enablePullRequestAutoMerge`
operation with `expectedHeadOid` and merge method `MERGE`. A verified,
non-draft publication and the person's authorized GitHub credential are
required. Factory runs must also satisfy the current candidate's existing
independent-review and handoff evidence. While that review is pending, the
existing publication workflow waits for its durable event. The server
rechecks the live effective preference before asking GitHub. A confirmed
request records `autoMergeRequestedAt`; an open PR remains open until GitHub
actually merges it. GitHub branch protection still applies.

Turning `prAutoMerge` off prevents requests that have not yet been accepted
by GitHub. It does not revoke an already accepted GitHub auto-merge request.
Use the provider's existing PR controls to cancel such a request.

## Workspace review configuration

| Key | Allowed value | Product default |
| --- | --- | --- |
| `codeReviewModel` | Model identifier, or empty to use the actor's authorized preference | `""` |
| `codeReviewSeverity` | `low`, `medium`, `high`, `critical` | `medium` |
| `codeReviewIgnoredPaths` | Up to 100 repository-relative globs | `[]` |
| `codeReviewOutput` | `comments` or `summary` | `comments` |

Members can read these settings. Only current workspace administrators can
write them. Personal overrides are rejected. Use the generic workspace
PATCH route and the `code-review` reset group. They return the same
`{value,source}` fields, with source `workspace` or `default`.

These preferences shape existing Factory review prompts and automatic PR
review tasks. Severity and ignored paths never waive task acceptance
criteria, security findings or evidence requirements. Model selection uses
the existing authorization and model-routing path.

Repository automation has a dedicated list because it identifies installed
repositories and their existing durable schedules:

| Method | Path | Body |
| --- | --- | --- |
| GET | `/api/settings/workspace/<uuid>/review-repositories` | None |
| PATCH | Same path | `{"repository":"v2/github.com/owner/repo","enabled":true}` |
| DELETE | Same path | `{"repository":"v2/github.com/owner/repo"}` |

Each method returns:

```json
{
  "workspaceId": "00000000-0000-4000-8000-000000000001",
  "repositories": [
    { "repository": "v2/github.com/owner/repo", "enabled": true, "updatedAt": "2026-11-20T00:00:00.000Z" }
  ],
  "availableRepositories": ["v2/github.com/owner/repo"]
}
```

This list has no inherited scalar values. GET requires membership; PATCH
and DELETE require current administrator membership. Enabling requires an
installed repository in that workspace. Unknown fields, another workspace,
another owner supplied in the body and malformed repository keys are
rejected. Desktop RPC uses `review-settings.getCodeReviewRepositories`,
`review-settings.saveCodeReviewRepository` and
`review-settings.deleteCodeReviewRepository` through the same actions.

Enabling creates or resumes one ordinary schedule for PR opened and pushed
events. Disabling pauses it; deleting uses the normal schedule deletion
path and retains its history. Redelivered events keep the existing dedupe
contract. Dispatch checks current role, configuration owner, runner,
workspace, repository installation and enabled state under the existing
database authority locks. Removing those permissions stops later dispatch
and controlled GitHub writes from an earlier managed request.

At the controlled Coordinator `github_call` boundary, summary mode permits
only tools identified as read-only by the official GitHub MCP catalogue.
Comments mode additionally permits a COMMENT review and its pending inline
comments on the exact configured repository and triggering PR. It cannot
approve, request changes, merge or write another PR. The existing workspace
deny and caller identity checks still apply. The host request marker remains
bound to the actual occurrence after configuration deletion, so an old
request cannot become unrestricted.

Native workers retain the existing readOnly policy. Their existing GitHub
credential and network exposure remain in force; this is not a claim that
arbitrary native network traffic cannot write to GitHub. No new credential
proxy, model client or network restriction is introduced.

## Migration and rollback

`20261120192100_settings_git_review.sql` adds typed PR defaults, workspace
review configuration, repository automation references and publication
snapshot columns. Registry writes mirror these typed columns in the same
transaction. The migration is repeatable; its executed filename and bytes
remain unchanged.

Roll back application code while retaining additive columns and saved
values. Existing branches and publication receipts stay valid. Before
rolling back automatic review behavior, disable its repository schedules
through the normal API and inspect provider-side pending actions. A database
rollback cannot undo a posted comment or a GitHub-accepted auto-merge request.

## Proof boundaries

`lib/code-review/settings.db.test.ts` uses PG17 and real route handlers,
registry writes, schedule event delivery and dispatch. It covers inheritance,
reset, migration replay, cross-user and cross-workspace refusals, role and
owner changes, revoked repository access and the controlled GitHub gate.
`tests/run-publications.db.test.ts` exercises frozen defaults through actual
admission and publication transactions, including existing Factory evidence
and verification refusals. Provider tests substitute transport responses;
they do not claim a live GitHub merge or a real model review. Existing Factory
and schedule PG suites retain their independent acceptance responsibilities.
