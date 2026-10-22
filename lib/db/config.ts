export function mikkaDatabaseURL(env: Record<string, string | undefined>) {
  return (env.VERCEL_ENV === 'preview' ? env.DATABASE_URL : undefined) ?? env.MIKKA_DATABASE_URL ?? env.ORVILO_DATABASE_URL
}
