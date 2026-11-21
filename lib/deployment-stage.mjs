/** The application's deployment stage is independent of its hosting platform.
 * NODE_ENV describes the compiled runtime, including production-built previews.
 * @param {Record<string, string | undefined>} env
 * @returns {'production' | 'preview' | 'development' | undefined}
 */
export function deploymentStage(env = process.env) {
  const explicit = env.MIKKA_DEPLOYMENT_STAGE ?? env.MIKKA_DEPLOYMENT_ENVIRONMENT
  if (explicit !== undefined) {
    if (explicit === 'production' || explicit === 'preview' || explicit === 'development') return explicit
    throw new Error('MIKKA_DEPLOYMENT_STAGE_INVALID')
  }
  // Hosting-provider variables do not define application deployment stages.
  return undefined
}
