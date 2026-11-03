# Production follow-up: deliverable completion semantics

Production deployment `dpl_C6gTHqAUkW5iojYgyJ6TydQaGxbW` is READY at merged main `a9f5444cb6e413dba84cf6aed82dd014d19ac059`. Its worker `e5bb2c481b762f8f5705a531e976da91977669bc` matches the pre-published, measured images. A normal smoke owner selected its own API key, submitted a natural-language cloud-file task and reached Factory execution. Unknown models were refused with HTTP 409 without changing the selected model.

## Confirmed production blocker

Occurrence 10 × impact 9 = **90**. Factory task `88d24b1c-c244-426b-8d31-1bc9b19be698` created the actual delivery file, retained it in a real local snapshot and submitted normally through the daemon. The server's completion transaction nevertheless changed the run to `stopped`: it still required repository verification/publication for every writable non-planning run. Factory then blocked execution as “Run ended without completed submission.” A retry hit the same mismatch.

The previous cloud fixture directly wrote `status='succeeded'` before invoking reconciliation. It tested the Factory stage transitions but skipped the exact transaction that production uses. Changing that fixture to `persistRunCompletion` reproduces the production failure (`stopped` instead of `succeeded`) before the fix.

## Fix and verification boundary

Claim and completion now share the host's execution-purpose classifier. Only a current running Factory execute binding, the owned run/repository and matching Bot scope can identify a no-repository workspace delivery. Such a submitted delivery can complete without a repository build or push. Independent review/verification and human acceptance remain mandatory. A report's claimed `deliverableCommit` never selects the purpose; unverified repository work with a forged value still stops.

The regression now drives execution, review and verification through the actual completion transaction before discovering/reading the Bot task and accepting it through the human store. It also checks another owner cannot identify the delivery. Repository publication tests retain push/branch requirements, even with a forged delivery snapshot field.

All fixtures use isolated loopback PostgreSQL 17, with provider/lifecycle boundaries explicitly replaced in the cloud database suite. A production rerun after the follow-up deployment remains required; no production success is claimed by this document's source revision. No browser tests run. The already-published worker images need no change for this web-only fix.
