/** Both nonce-scoped attempts run even if one connection fails. No DELETE. */
export async function revokeSyntheticMailboxCredentials(pool, { runId, owner, deviceTokenId }) {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => pool.query('update run_tokens set "revokedAt"=coalesce("revokedAt",now()) where "runId"=$1 and "userId"=$2', [runId, owner])),
    Promise.resolve().then(() => pool.query('update device_tokens set "revokedAt"=now() where id=$1 and "userId"=$2', [deviceTokenId, owner])),
  ])
  if (results.some(result => result.status === 'rejected')) throw Error('PERSONAL_MAILBOX_CI_CREDENTIAL_REVOKE_FAILED')
  return results.map(result => result.value.rowCount)
}
