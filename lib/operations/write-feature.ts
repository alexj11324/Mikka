/** Default remains closed until the matching database and provider are ready. */
export const PERSONAL_WRITES_ENABLED: boolean = false

/** Server configuration controls availability, never provider authority;
 * request bodies, model output and browser parameters cannot change this gate.
 * The regular per-tool permission and durable execution checks still apply.
 * An explicit value overrides the legacy Preview acceptance switch, allowing
 * the deployment to close admission again without changing application source. */
export function personalWritesEnabled(env: Record<string,string|undefined> = process.env): boolean {
  if (env.MIKKA_PERSONAL_WRITES_ENABLED !== undefined) return env.MIKKA_PERSONAL_WRITES_ENABLED === '1'
  return PERSONAL_WRITES_ENABLED || (env.VERCEL_ENV === 'preview' && env.MIKKA_PERSONAL_WRITES_PREVIEW === '1')
}
