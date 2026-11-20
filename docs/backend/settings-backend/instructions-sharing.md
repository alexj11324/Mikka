# Workspace instructions and sharing defaults

P3 of #2956 uses P1's registered settings write/reset/read surface. Workspace instructions are a distinct 2000-character text, stored in `workspace_instructions`; they are not thread title naming instructions. Administrators write and members read. Each product prompt combines platform rules, workspace instructions, then the person's existing personal instructions.

`threadShareVisibility` and `artifactShareVisibility` accept `private`, `workspace`, or `link`. Their default values are `private` and `link` respectively, retaining existing private threads and explicitly created artifact links. Only workspace administrators write these defaults. Reads expose value/source and reset falls back to the registry default. Changing a default does not retroactively publish or revoke existing resources.

`readWorkspaceSharingDefaults(workspaceId)` is an internal consumer for an already admitted resource workspace. It provides both values and provenance, not authorization. Artifact share writers consume it in this P. Thread sharing/lifecycle is owned by #2936; this P supplies its settings contract without duplicating that implementation.

Issue prefixes remain personal `issue_prefixes` plus team identifier, as decided in P1. There is no second workspace prefix.

The workspace instruction prompt reader resolves the bot's actual workspace and rechecks current membership on every turn. A revoked member cannot obtain the text from a previously owned bot. Formatting keeps platform rules first and strips instruction section delimiters supplied in workspace text.

Migration `20261120192546_workspace_instructions.sql` is additive and replayable, keeps registry writes and prompt storage in one application transaction, and does not change title or personal instruction columns. Roll back application code normally and retain the additive table and its data; no production migration has been run.

Verified locally: 15 prompt assembly/preference unit tests; 9 combined registry/instruction PG17 tests, including unauthenticated, cross-workspace and ordinary-member write rejection, current bot ownership and revoked membership, 2000-character limits, default provenance, reset and migration replay; root/API types, targeted lint, migration checks and 21 CI inventory tests. Artifact share consumption is being added in a subsequent checkpoint. Complete CI and deployed frontend acceptance are still pending. No model calls or production migrations.
