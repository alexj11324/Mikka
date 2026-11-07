/** A platform rewrite keeps the optional service on the existing cookie origin.
 * Community deployments never acquire an implicit Mikka service dependency. */
export function cloudServiceRewrite(env = process.env) {
  if (env.MIKKA_EDITION !== 'cloud' || !env.MIKKA_CLOUD_BACKEND_URL) return null
  let target
  try { target = new URL(env.MIKKA_CLOUD_BACKEND_URL) }
  catch (cause) { throw new Error('CLOUD_BACKEND_URL_INVALID', { cause }) }
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash
    || target.pathname !== '/' || target.origin !== env.MIKKA_CLOUD_BACKEND_URL) throw new Error('CLOUD_BACKEND_URL_INVALID')
  return { src: '^(/mikka/cloud(?:/.*)?)$', dest: `${target.origin}$1` }
}
