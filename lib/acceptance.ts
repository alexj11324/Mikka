import 'server-only'

export function isAcceptanceEnabled() {
  return process.env.NODE_ENV === 'development' && process.env.VERCEL_ENV !== 'production'
}
