# Workspace instructions and sharing defaults

P3 of #2956 uses P1's registered settings write/reset/read surface. Workspace instructions are a distinct 2000-character text, stored in `workspace_instructions`; they are not thread title naming instructions. Administrators write and members read. Each product prompt combines platform rules, workspace instructions, then the person's existing personal instructions.

`threadShareVisibility` and `artifactShareVisibility` accept `private`, `workspace`, or `link`. Their default values are `private` and `link` respectively, retaining existing private threads and explicitly created artifact links. Only workspace administrators write these defaults. Reads expose value/source and reset falls back to the registry default. Changing a default does not retroactively publish or revoke existing resources.

`readWorkspaceSharingDefaults(workspaceId)` is an internal consumer for an already admitted resource workspace. It provides both values and provenance, not authorization. Artifact share writers consume it in this P. Thread sharing/lifecycle is owned by #2936; this P supplies its settings contract without duplicating that implementation.

Issue prefixes remain personal `issue_prefixes` plus team identifier, as decided in P1. There is no second workspace prefix.

Implementation and validation in progress; no model calls or production migrations.
