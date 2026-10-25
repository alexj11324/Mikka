import { subscriptionVaultTokens } from './subscription-vault-auth'
import 'server-only'
import { retainEnrollmentSourcesForAcceptance } from './subscription-enrollment-policy'
import type { EnrollmentConfiguration } from './subscription-enrollment'

// No DB/auth/reader dependency: first consent remains a custody-only operation.
export function enrollmentConfiguration(): EnrollmentConfiguration {
  const config = {
    binary: process.env.MIKKA_BYOS_ENROLLMENT_BINARY,
    infisicalOrigin: process.env.MIKKA_BYOS_INFISICAL_ORIGIN,
    project: process.env.MIKKA_BYOS_INFISICAL_PROJECT,
    environment: process.env.MIKKA_BYOS_INFISICAL_ENVIRONMENT,

    attemptPath: process.env.MIKKA_BYOS_ENROLLMENT_ATTEMPT_PATH,
    claimPath: process.env.MIKKA_BYOS_ENROLLMENT_CLAIM_PATH,
    grantPath: process.env.MIKKA_BYOS_ENROLLMENT_GRANT_PATH,
  }
  if (Object.values(config).some(value => !value) || process.env.MIKKA_BYOS_VAULT_AUTH !== 'universal') throw new Error('subscription_enrollment_unavailable')
  // The isolated acceptance deployment retains its test records pending approval.
  return { ...config, workloadToken: '', tokens: subscriptionVaultTokens(), retainSources: retainEnrollmentSourcesForAcceptance() } as EnrollmentConfiguration
}
