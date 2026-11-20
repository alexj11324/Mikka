# New thread and Bot visibility in workspace settings

P3 of #2956 also supplies the creation preferences promised by #2957. These
settings concern a new ordinary Bot or root thread. They do not change Task
creation visibility or replace the separate thread/artifact share-link scope.

`newWorkVisibility` is `private` or `shared`. A person's override belongs to the
selected workspace; null inherits its workspace default, then the registry's
private default. Changing one workspace never changes the person's preference
in another. Members may write their own override. Administrators alone write
workspace defaults and `allowPrivateNewWork`, whose default is true.

The ordinary settings values and their personal/workspace/default source keep
P1's inheritance contract. A separate `workCreation` projection reports the
configured preference, effective visibility, private allowance and policy
reason. When a team disallows private work, the effective default is shared
even if a saved preference is private. An explicit private creation is refused.
Personal workspaces and the person's Coordinator remain private.

The policy applies to subsequent creation and a shared-to-private change. It
does not rewrite existing private content, restore grants or lift an ancestor's
ACL. Existing private resources remain private when an administrator changes
the setting. Continued or retried executions do not become new root threads
merely because their next run is inserted.

Existing Bot and thread writers own insertion and access registration. They
apply this policy in their existing transaction while authoritative workspace
membership remains held. #2936 retains fork, side threads, share links, soft
deletion and lifecycle operations; this change does not add competing writers.

The contract and runtime integration are documented in
`docs/backend/settings-backend/instructions-sharing.md`. Backend verification
does not establish that the frontend has consumed the new projection.
