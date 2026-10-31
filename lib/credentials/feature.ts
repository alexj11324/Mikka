/** Availability is not a credential grant. Current owner/run authorization,
 * page binding and the configured KMS/broker remain required by the runtime. */
export function credentialVaultEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.CREDENTIAL_VAULT_ENABLED === undefined || env.CREDENTIAL_VAULT_ENABLED === '1'
}
