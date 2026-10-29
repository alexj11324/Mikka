/** Production release remains closed until actual feature acceptance. */
export const PERSONAL_WRITES_ENABLED: boolean = false

/** Existing server-owned Preview configuration admits functional acceptance;
 * request bodies, model output and browser parameters cannot change this gate.
 * The regular per-tool permission and durable execution checks still apply. */
export function personalWritesEnabled(env: Record<string,string|undefined> = process.env): boolean {
  return PERSONAL_WRITES_ENABLED || (env.VERCEL_ENV === 'preview' && env.MIKKA_PERSONAL_WRITES_PREVIEW === '1')
}
