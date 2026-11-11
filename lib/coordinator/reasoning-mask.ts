import { assertNoSecret, type SecretFingerprint } from '@/lib/credentials/fingerprint'
import { credentialMasker } from '@/lib/secrets/mask'

/** Stored reasoning is displayed only after credential masking and saved-secret checks. */
export function reasoningText(userId: string, text: string, fingerprints: SecretFingerprint[]): string | undefined {
  const masked = credentialMasker(text.trim())
  if (!masked) return undefined
  try { assertNoSecret(userId, masked, fingerprints) } catch { return undefined }
  return masked
}
