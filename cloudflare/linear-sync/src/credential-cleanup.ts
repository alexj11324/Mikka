/** Reuses the existing app/Worker cron trust boundary. Default-off until the
 * app cleanup runtime and deployment cadence have been independently verified. */
export const CLEANUP_ENDPOINT = 'https://app.aspectlylabs.com/mikka/api/cron/credential-cleanup'
export interface CleanupEnv { CRON_SECRET?: string; CREDENTIAL_CLEANUP_ENABLED?: string }
export async function runCredentialCleanup(env: CleanupEnv, request: typeof fetch = fetch) {
  if (env.CREDENTIAL_CLEANUP_ENABLED !== '1') return { enabled: false as const }
  if (!env.CRON_SECRET) throw new Error('credential_cleanup_not_configured')
  try {
    const response = await request(CLEANUP_ENDPOINT, {
      method: 'GET', headers: { authorization: `Bearer ${env.CRON_SECRET}` },
      redirect: 'error', signal: AbortSignal.timeout(20_000),
    })
    if (response.status !== 200) { await response.body?.cancel(); throw new Error() }
    const result: unknown = await response.json()
    if (!result || typeof result !== 'object' || !('checked' in result) ||
        !Number.isInteger(result.checked) || Number(result.checked) < 0 || Number(result.checked) > 100) throw new Error()
    return { enabled: true as const, checked: Number(result.checked) }
  } catch { throw new Error('credential_cleanup_failed') }
}
