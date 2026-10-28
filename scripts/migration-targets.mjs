/** Resolve the same application/workspace targets used by the runtime. */
export function migrationTargets(env) {
  if (env.VERCEL_ENV === 'preview') {
    const url = previewDatabaseURL(env)
    return { MIKKA_DATABASE_URL: url, DATABASE_URL: url }
  }
  return { MIKKA_DATABASE_URL: env.MIKKA_DATABASE_URL, DATABASE_URL: env.DATABASE_URL }
}
import { previewDatabaseURL } from './preview-database-url.mjs'
