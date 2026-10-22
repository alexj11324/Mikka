export function isPostgresUniqueViolation(error: unknown) {
  if (typeof error !== 'object' || error === null) return false
  if ('code' in error && error.code === '23505') return true
  const cause = 'cause' in error ? error.cause : null
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === '23505'
}
