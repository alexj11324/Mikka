import 'server-only'

/** Retention hold: no automatic database deletion is authorized. */
export async function cleanupCredentialInputs() {
  return { disabled: true }
}
