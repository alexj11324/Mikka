# Second-stage Factory simplification

## #492: candidate approval

Evidence GET is read-only. Human approval does not require an evidence read receipt or matching evidence digest; it binds the current candidate and SHA. Old clients may still send the evidence fields during rollout. The expand migration stops new digest writes; the old column and receipt table remain until a post-deploy contract migration.

## #493: human publication

The unused run-decision-authority, run-review-issuer, publication-invocation, worker-publication, policy-authorization and decision-execution modules are removed. Before removal, repository search found references only within that module cluster, approval/publication support branches and tests; no production route or worker invoked the authority/issuer/worker entry points.

Approval and publication require a live linked human session. Supplying a decisionCredentialId is rejected rather than granting authority. Publication input hashes include that human session. The three decision columns already allow null and remain in the schema for the later contract migration; new grants do not write them. Existing human approvals remain usable, while old policy-only grants cannot authorize a new publication.
