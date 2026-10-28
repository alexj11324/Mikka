import { previewDatabaseURL } from '../../scripts/preview-database-url.mjs'

export function mikkaDatabaseURL(env: Record<string, string | undefined>) {
  return env.VERCEL_ENV === 'preview' ? previewDatabaseURL(env) : env.MIKKA_DATABASE_URL
}

export function workspaceDatabaseURL(env: Record<string, string | undefined>) {
  return env.VERCEL_ENV === 'preview' ? previewDatabaseURL(env) : env.DATABASE_URL
}
