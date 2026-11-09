# Official Codex/Desktop path control — closed evidence archive

This archive preserves the frozen preparation, actual first and second bound three-file sources, offline validation, both run records, both complete job logs, original artifact ZIP and its three extracted JSON members, and both normal closure receipts.

- First run 42668993157 / attempt 1 failed at the offline guard-test step: 35/36 passed. SDK installation, OIDC and cloud resource creation had not started. Unit-test fake cleanup JSON in that log is not an actual cloud cleanup receipt.
- The corrected second local suite passed 36/36. Its execution receipt and the later UTC-only window rebinding remain distinct original records.
- Actual second run 42670291715 / attempt 1, job 129344720782, completed successfully. Codex reproduced the exact root CA regular-file mode change from 0644 before/pre_finalization to 0777 ready/fresh. Desktop's two exact APT nodes and four unit observations remained unchanged across all four phases.
- The unique original artifact ZIP is preserved unchanged: 3353 bytes, SHA256 2aa02beb720a3e3922bafa5ba81344529a22e76ea14588717de0f9e11255b268. Original CRC/member verification is in the root-supplied artifact-verification.json; this archive process did not rerun the control or redownload it.
- Actual cleanup recorded two exact templates absent and two exact sandbox IDs with absenceConfirmedById true, errors []. The second carrier was normally closed at 376298951e4eee5970e2f0d00e21acb3ffba4e18; closure run 42670790551 skipped.
- This is targeted official-only control evidence, not complete filesystem conservation, a runtime release, model execution, or a formal six-case performance PASS. Desktop non-reproduction does not identify the writer of the earlier changed backup.

INDEX.json lists every source path, byte length, SHA256, Git blob and archive path. It also lists six excluded duplicate Git-backed source files, their exact OIDs and known source commits. Original manifests are preserved verbatim even where their source copies are excluded. The actual observer/test/workflow sources for the preparation and both bound versions are retained. Archived .github/workflows paths are nested under this evidence subtree and cannot activate a workflow.

archive-tools/inventory.py is the exact local inventory/staging implementation. It uses the original sibling-directory layout recorded in INDEX.json and performs no Git, network, SDK, observer or test execution.

Archive base: dd873c0515f01d40298dd04806365b265fc7da3c, tree 4f7f6dbbe46d6929eba0a8d198e3dc3a4dfec955. The archive creates only one new root subtree; the original 84 root entries must remain identical. No ref is updated by this archive transfer.
