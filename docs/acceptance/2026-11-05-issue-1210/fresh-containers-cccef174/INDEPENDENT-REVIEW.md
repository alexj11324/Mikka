# Independent review of #1217 integration with fc2

Reviewed final candidate tree `ccf5f3bda4281fe7b74def96f7d269d77d495727`, prior `c60850bf3e44228869485e4157832865f160e9d0`, base `fc2d401bde7b3f567b1288b01accd6fdeb433d0c`.

I read the complete `upstream-intersection.patch`, the final thread-machine admission, fresh-template, retained-machine, lease COMMIT and failure branches, the packet's two new blobs, results and cleanup receipts. I independently recomputed both new Git blob hashes; they match the packet.

No new blocking finding in this integration:

* The #1288 WeakMap proof is registered only after the actual startup lease transaction committed, for a normal fresh-start failure. Public error properties and serialized/replayed errors cannot forge this proof.
* Runtime refresh, exact question continuation and retained task-machine failures take their earlier dedicated branches. Their existing owner/workspace/device/issue, stop, worker lease and original-runtime fences remain in place.
* Fresh tasks still select the official harness template and do not regain a requirement that the parent sandbox already exist or run. The join to the owned cloud metadata/binding remains; it does not impose parent sandbox state.
* The package command preserves main's tool-activity and chat-dedupe cases alongside #1217's existing tests.

The actual supplied startup/Factory-end/fallback log reports 49/49, zero skips. The independent database cleanup receipt reports the named test database absent. I did not rerun those tests. The inherited whitespace failure and the successful check against the actual PR base are both retained, rather than silently changing unrelated main code.

This is a source/integration review, not evidence that paid cloud subscription legs or production acceptance passed.

## Final one-line fixture correction

I independently retrieved the GitHub comparison from `aaf5256a726e57a4611cee3f9736d08fafcfb9ab` to `cccef174f7a4e604a820a4b61f8521e8cdba100b`. It contains exactly one deletion in `lib/factory/run-end-paths.db.test.ts`, resulting blob `23597148d360504680c71db62e4b5fc9fd9460ca`: the unused `snapshot` stub that no longer belongs to the provider interface. The adjacent `connect`, `create` and `kill` assertions remain. No product path, lease proof, permission check or assertion was removed.

I read the final raw typecheck log and exit-0 receipt, the real run-end PG log reporting 12/12 with zero skips, the actual-base whitespace check and the independent test-database-absent receipt. This resolves the TypeScript fixture mismatch found by CI; it does not turn the earlier compile failures into passes. I did not rerun these tests and still make no paid cloud or production acceptance claim.
