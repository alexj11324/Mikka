# Fixed P0 / observability premerge objects

This is a reviewable content union of c0e94d594f1ecf4f5edc25904912702e61fce86b (tree 3e09885ffb34a9c04fc8a7ac5b8b88e3415f7325) and P0 61f359952fbc8a18de4160926632c58cba2cb432 (tree ed46d344055cf47c7ae4802a947d9401cd736021), against base 89eae89e9e79422e0a8b4b1346aa1c7fb6470016. It changes no branch and has no runtime acceptance claim.

## Eight intersections

Six candidate contents are in source-manifest.safe.json. The two daemon fake scripts retain the same original blobs and mode 100755 on both heads, requiring no new content.

- RPC combines the existing snapshot-only pending callback with P0's response-aware isCurrent type and checks after fetch and JSON. Encoding, failure paths, final response proof and wire body remain unchanged.
- Coordinator retains withRunSpan('coordinator.tool', {}, fn) and all P0 bot-derived Workspace/actAs/tokenWorkspace checks. The P0 tools.ts dependency passes botId to all five affected callers and must survive the eventual ordinary merge.
- Heartbeat keeps all 41 existing assertion lines from ours, strict two-SQL measurement, four real params-barrier races, nonempty and disabled cases. P0's original heartbeat Workspace fixture is preserved. The only additional semantic adaptation seeds the newly added runs-test queued fixture through seedFixtureWorkspace and binds workspaceId outside measured().
- package.json retains six P0 script changes and both changed keys from ours. test:issues keeps main's task-thread-pane test; test:captures keeps the installer test. Every non-script field remains equal to all preimages.
- The route union retains all 243 entries and 315 methods. Relative to P0, only our two runs/repos sourceHash values change in each generated file; relative to ours, only P0's 22 disjoint sourceHash values change.

## Evidence and limits

All 20 unique preimage blobs were read in full and verified by Git blob SHA-1 and SHA-256. The existing review's six base-to-head hunk sequences reproduce their full originals exactly. Both candidate patches were independently replayed with full-file hash preconditions and exact hunk context: 12 forward and 12 reverse checks pass; 12 changed-source and 12 changed-hunk negative checks refuse.

The same generator blob is present on both fixed sources. Its JSON and TS serialization formulas reproduce all three original generated files byte-for-byte. All 24 changed route source texts were read and their SHA-256 values agree. No filesystem route walk or TypeScript AST inspection was executed. The generator source does not implement a --check flag; the eventual candidate must run the repository's actual canonical generation/diff gate, source checks, PG and Native validation. This static proof is not that runtime gate.

Previous c0e94 Native results remain bound to c0e94/9d8aab and do not validate this union. No driver or installer implementation is changed here. The P0 owner may add changes to address the separately reported Factory default-selection contract; actual P0/main and every preimage must be checked again before publication.

Only immutable Git blobs were created. No VM, production request, model execution, CI, commit, branch or ref was created/updated.
