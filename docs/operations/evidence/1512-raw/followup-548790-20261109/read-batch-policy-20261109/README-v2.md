# Active readBatch policy observation — v2 review

The original v1 patch, manifests, red/green logs, and source snapshots remain unchanged. Use `read-batch-policy-v2.patch` against tree a69946cdb08bceb994e11b3278572bea5e7e63c9. Only three source files differ.

The original source issues two policy SELECTs for the actual key/subscription consumer seam. v1 shares that observation, but the added real afterJob regression exposed inherited use while the parent batch remains active. v2 excludes existing after:, cron:, and workflow: contexts only for policy reuse. It preserves the original background schedule and reads. The active-afterJob baseline is 0/1 pass with true !== false; the final three focused files pass 38/38. Explicit no-ignore three-file lint and git diff check exit zero. No canonical repository typecheck or production run is claimed.

The original Native473 / Web402 acceptance remains RED. At most four observations are source-inferred eligible for reuse in that retained run; 469 is a counterfactual, not a measured result or acceptance. No background query, auth/PKCE request, checkpoint, or window was removed or moved.

The currentRoute marker is the existing innermost global route scope installed by afterJob/cronJob/runJob. The implementation does not alter the scheduler or create a new execution context. All database/owner/workspace and consumer guards remain in their original paths.
