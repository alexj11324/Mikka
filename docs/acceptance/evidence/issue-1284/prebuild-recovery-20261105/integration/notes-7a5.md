# Main d76 integration checkpoint

This local normal merge preserves public4f66734 staging ancestry, picker74bf and main d76. It retains the single atomic Profile-and-reason protocol introduced by main and the host-defined current Review assignment from the source branch. The only additional diagnostic behavior is exact-table mapping of a validated complete pair to a safe eligible UUID, retaining finite low-confidence evidence without accepting it. Bare IDs, unknown pair reasons and legacy double answers remain refused.

The actual intersection passed15 unit cases plus49 Profile PG cases and47 dispatch PG cases (111 total, zero fail/skip). Types/lint/diff pass. The pair-diagnostic regression was first observed as14/15 before its adaptation. PG gates ran on clean local7a5bc4eb; static gates ran on the identical final staged source immediately before commit. No models or providers were called.

This is an intermediate integration checkpoint awaiting the separately owned queued-Stop repair. The final immutable batch must still receive its own build, authenticated HTTP/capture and CI. This record does not establish the unknown historical confidence value or production Review success.

The PG recovery cases use the domain handleFactory handler with synthetic Owner identity, not a live Next HTTP server or production Owner session.
