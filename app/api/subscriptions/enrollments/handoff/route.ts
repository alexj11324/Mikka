import { enrollmentHandoffHTTP, enrollmentHandoffPage } from '@/lib/subscription-enrollment-handoff'
import { EnrollmentClient } from '@/lib/subscription-enrollment'
import { enrollmentConfiguration } from '@/lib/subscription-enrollment-runtime'

export const runtime = 'nodejs'
export const maxDuration = 120
const enabled = () => process.env.MIKKA_BYOS_ENROLLMENT_ENABLED === '1'
export const POST = enrollmentHandoffHTTP({ enabled, client: () => new EnrollmentClient(enrollmentConfiguration()) })
export const GET = (request: Request) => enrollmentHandoffPage(request, enabled())
