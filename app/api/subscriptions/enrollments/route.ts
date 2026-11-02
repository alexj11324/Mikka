import { enrollmentHTTP, enrollmentOperator, EnrollmentClient } from '@/lib/subscription-enrollment'
import { enrollmentConfiguration } from '@/lib/subscription-enrollment-runtime'
import { byosEnrollmentEnabled } from '@/lib/cloud-computer-flag'

export const runtime = 'nodejs'
export const maxDuration = 120

// This private operator-controlled receiver creates pending-unbound custody only.
// It never pretends that an operator token is a Mikka account/workspace session.
export const POST = enrollmentHTTP({
  authorize: async request => byosEnrollmentEnabled()
    ? enrollmentOperator(request, process.env.MIKKA_BYOS_ENROLLMENT_OPERATOR_TOKEN) : null,
  client: () => new EnrollmentClient(enrollmentConfiguration()),
})
