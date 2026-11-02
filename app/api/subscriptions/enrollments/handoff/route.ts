import { enrollmentHandoffHTTP, enrollmentHandoffPage } from '@/lib/subscription-enrollment-handoff'
import { EnrollmentClient } from '@/lib/subscription-enrollment'
import { enrollmentConfiguration } from '@/lib/subscription-enrollment-runtime'
import { byosEnrollmentEnabled } from '@/lib/cloud-computer-flag'

export const runtime = 'nodejs'
export const maxDuration = 120
const enabled = () => byosEnrollmentEnabled()
export const POST = enrollmentHandoffHTTP({ enabled, client: () => new EnrollmentClient(enrollmentConfiguration()) })
export const GET = (request: Request) => enrollmentHandoffPage(request, enabled())
