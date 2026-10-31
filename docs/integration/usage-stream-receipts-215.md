# Interrupted streaming receipts (#215)

The hosted model wrapper previously extracted the Gateway generation ID only
from the finish part. The Gateway sends it on the first content part. Losing a
stream before finish therefore discarded an already available lookup identity.
In addition, TransformStream.flush does not handle source errors or downstream
cancellation, so those calls could remain pending rather than honestly unknown.
This is a normal network/cancellation failure path (occurrence 5 × impact 6).

The wrapper now persists an explicit Gateway generation ID before delivering its
first content. It records unknown cost on interrupted, truncated or cancelled
streams and retains that same ID for later authoritative reconciliation. A final
receipt may omit the ID without erasing the earlier one; a conflicting ID cannot
replace it or settle its row. Cancellation still propagates to the source stream.
No estimated money is reserved and no cost is guessed from an ID or token count.
Only a known final receipt charges the actual amount, once.

Verification uses the installed Gateway 4.0.121 streaming parser, real loopback
HTTP/SSE and an existing isolated PostgreSQL target: source disconnect,
cancellation, early durable ID, zero financial reservation, final receipt lacking
an ID, conflicting identity refusal and idempotent settlement. Provider values are
synthetic and do not establish real-provider acceptance. The normal model tests
also cover the three terminal paths. The new DB case runs in test:abuse-db and its
normal required-CI inventory.

Sources verified before implementation:
- Installed @ai-sdk/gateway/docs/00-ai-gateway.mdx, Generation Lookup.
- https://vercel.com/docs/ai-gateway/observability-and-spend/usage
- Installed @ai-sdk/provider v4 stream-part definitions.

This prevents losing lookup identities on new streams. It does not recover the
old production receipt that never recorded a generation ID, manufacture its cost,
refund its reserve, or add a new billing reconciliation platform. The broader
#215 accounting/entry coverage and that historical receipt stay separately open.
