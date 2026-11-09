# 官方目录权限控制 / Official directory permission control

This change permits one measured provider-finalization transition: the existing
Claude directory `/usr/local/share/e2b` changes from mode 0755 to 0777.
The entry must remain a directory. Its owner and group remain root (uid/gid 0).
Strict installation verification still rejects this change. No Desktop or
`/var/backups` exception is added.

## Immutable evidence

- Product source: `e78fccffd9dd878edd490b113ea80efcff1525e7`.
- Control operator: `1e351dcfe9a4c93430f8e67fabef5b3dc97385e0`.
- [Control run 42619272499, attempt 1](https://github.com/alexj11324/Mikka/actions/runs/42619272499).
- Artifact: `13676555208`; original ZIP: **3810 bytes**.
- Original ZIP SHA256: `5639a4565249a7e169bd156d71d8c2fd4663c464ebe824cdd4813fbdf4942fd6`.
- [Complete exported control evidence](evidence/1506-official-base-conservation-control-20261109.json):
  copied byte-for-byte from EXPORT.json, SHA256
  `c7e0f28675c9534f79cfa2402a32b67c38ab536477da8e969e779706b364ff2b`.
  It includes both Claude and Desktop, all recorded stages, and the original
  `targetedOnly: true` / `releaseAccepted: false` scope.

Claude showed directory mode 0755 at before and pre_finalization, then 0777 at
ready and fresh. Type, uid and gid stayed unchanged. Its original CLI SHA256
was identical at all four stages:
`4f4178ce41d83e23341ebfbaecdbcf8ea6bf7baea0690025abe49eeec3a5d01d`.
The certificate archive's existing finalization policy is unchanged.

Desktop had one 240-second no-operation interval in one boot. The observed
backup SHA256 was unchanged across all four stages. This did **not** reproduce
or fix the earlier Desktop backup mutation, identify its writer, or justify
a backup exclusion. No APT lock, service change or new exception is introduced.

## Safety and limits

The new `_kind` rule constrains the original entry type while keeping the actual
`kind` field in the normalized receipt digest. Unknown paths, other templates,
other mode transitions, owner/group changes, type/link changes and changes to
original child-file content remain refused. The original installation receipt
must still match before/after exactly.

This is targeted provider evidence. It does not prove full-file conservation,
a complete release, subscription execution or production first-text latency.
The control resources were cleaned by the original runner; their exact cleanup
receipts remain in the complete export. Root also recorded control closure
`f7b488b12093bf04bcf5c408fbb6e9becafd4f21` / run `42620165695`
(`skipped`).

中文范围说明：仅修复 Claude 指定目录的已实测权限变化；Desktop 未复现，
不增加任何备份例外，不将定点控制当作完整发布或生产验收通过。
