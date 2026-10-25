/** Trusted server configuration only. Shared mode changes identity admission, not
 * vault permissions, token lifetime, owner checks, or logical cache ownership. */
export function subscriptionVaultCredentials(env: NodeJS.ProcessEnv, role: 'custody' | 'access' | 'source') {
  if (env.MIKKA_BYOS_VAULT_AUTH !== 'universal') return undefined
  const prefix = role === 'source' ? 'MIKKA_BYOS_TRANSFER_SOURCE' : `MIKKA_BYOS_${role.toUpperCase()}`
  const clientId = env[`${prefix}_CLIENT_ID`], clientSecret = env[`${prefix}_CLIENT_SECRET`]
  if (!clientId || !clientSecret) return undefined
  const shared = env.MIKKA_BYOS_SHARED_IDENTITY === '1'
  if (!shared && ((role === 'access' && clientId === env.MIKKA_BYOS_CUSTODY_CLIENT_ID) ||
    (role === 'source' && [env.MIKKA_BYOS_CUSTODY_CLIENT_ID, env.MIKKA_BYOS_ACCESS_CLIENT_ID].includes(clientId)))) return undefined
  return { clientId, clientSecret }
}
