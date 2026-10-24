import { enrollmentHTTP, enrollmentOperator, EnrollmentClient } from '@/lib/subscription-enrollment'

export const runtime = 'nodejs'
export const maxDuration = 120

// This private operator-controlled receiver creates pending-unbound custody only.
// It never pretends that an operator token is a Mikka account/workspace session.
export const POST = enrollmentHTTP({
  authorize: async request => process.env.MIKKA_BYOS_ENROLLMENT_ENABLED === '1'
    ? enrollmentOperator(request, process.env.MIKKA_BYOS_ENROLLMENT_OPERATOR_TOKEN) : null,
  client: () => {
    const config = {
      binary: process.env.MIKKA_BYOS_ENROLLMENT_BINARY,
      infisicalOrigin: process.env.MIKKA_BYOS_INFISICAL_ORIGIN,
      project: process.env.MIKKA_BYOS_INFISICAL_PROJECT,
      environment: process.env.MIKKA_BYOS_INFISICAL_ENVIRONMENT,
      workloadToken: process.env.MIKKA_BYOS_INFISICAL_TOKEN,
      attemptPath: process.env.MIKKA_BYOS_ENROLLMENT_ATTEMPT_PATH,
      claimPath: process.env.MIKKA_BYOS_ENROLLMENT_CLAIM_PATH,
      grantPath: process.env.MIKKA_BYOS_ENROLLMENT_GRANT_PATH,
    }
    if (Object.values(config).some(value => !value)) throw new Error('subscription_enrollment_unavailable')
    return new EnrollmentClient(config as { [K in keyof typeof config]: string })
  },
})
