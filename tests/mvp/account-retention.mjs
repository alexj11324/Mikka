/** Business fixtures keep their mutations, so their leased accounts cannot be reused. */
export async function retainMvpAccountLease(accounts) {
  const closed = await Promise.allSettled([accounts.owner.context.close(), accounts.peer.context.close()])
  // Use the pool's normal revocation/fencing lifecycle. Dirty release retains
  // business rows and private evidence and quarantines this pair, without reset.
  const result = await accounts.scope.release({ outcome: 'dirty' })
  if (result.state !== 'quarantined') throw new Error('MVP_ACCOUNT_QUARANTINE_REQUIRED')
  if (closed.some(item => item.status !== 'fulfilled')) throw new Error('MVP_ACCOUNT_CONTEXT_CLOSE_FAILED')
  return { leaseId: result.id, environmentId: result.environmentId, generation: result.generation, state: result.state, reason: 'retained-business-fixtures' }
}
