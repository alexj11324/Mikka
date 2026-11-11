/** The application's deployment stage is independent of its hosting platform.
 * NODE_ENV describes the compiled runtime, including production-built previews.
 * @param {Record<string, string | undefined>} env
 * @returns {'production' | 'preview' | 'development' | undefined}
 */
export function deploymentStage(env = process.env) {
  const explicit = env.MIKKA_DEPLOYMENT_STAGE
  if (explicit !== undefined) {
    if (explicit === 'production' || explicit === 'preview' || explicit === 'development') return explicit
    throw new Error('MIKKA_DEPLOYMENT_STAGE_INVALID')
  }
  // Preserve existing Vercel deployment-name semantics when no explicit stage
  // is configured. An ordinary local production build does not imply a stage.
  if (env.VERCEL_ENV === 'production' || env.VERCEL_ENV === 'preview') return env.VERCEL_ENV
  return env.VERCEL_ENV ? 'development' : undefined
}
