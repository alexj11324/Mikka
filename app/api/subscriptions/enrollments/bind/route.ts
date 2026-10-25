import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { authorizeSubscriptionWorkspace } from '@/lib/subscription-runtime'
import { EnrollmentClient, enrollmentOperator } from '@/lib/subscription-enrollment'
import { enrollmentConfiguration } from '@/lib/subscription-enrollment-runtime'
import { enrollmentBindHTTP } from '@/lib/subscription-enrollment-bind'
import { enrollmentBindingDatabaseIdentity, enrollmentBindingPage, verifyEnrollmentBindingProof } from '@/lib/subscription-enrollment-binding-proof'

export const runtime = 'nodejs'
export const maxDuration = 120
export const GET = () => process.env.MIKKA_BYOS_ENROLLMENT_ENABLED === '1' ? enrollmentBindingPage() : new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } })

export const POST = enrollmentBindHTTP({
  operator: async request => process.env.MIKKA_BYOS_ENROLLMENT_ENABLED === '1' ? enrollmentOperator(request, process.env.MIKKA_BYOS_ENROLLMENT_OPERATOR_TOKEN) : null,
  session: async request => {
    const session = await auth.api.getSession({ headers: request.headers })
    return session ? { userId: session.user.id } : null
  },
  handoff: async (request, ownerId, body) => {
    const operator = process.env.MIKKA_BYOS_ENROLLMENT_OPERATOR_TOKEN
    const databaseUrl = pool.options.connectionString
    if (process.env.MIKKA_BYOS_ENROLLMENT_ENABLED !== '1' || !operator || !databaseUrl || !body.proof) return null
    if (!verifyEnrollmentBindingProof(operator, body.proof, { id: body.id, ownerId, workspaceId: body.workspaceId, origin: new URL(request.url).origin, databaseIdentity: enrollmentBindingDatabaseIdentity(databaseUrl) })) return null
    // The original custody principal is always derived from server config.
    return enrollmentOperator(new Request(request.url, { headers: { authorization: `Bearer ${operator}` } }), operator)
  },
  workspace: authorizeSubscriptionWorkspace,
  client: () => {
    const databaseUrl = pool.options.connectionString
    const canonicalGrantPath = process.env.MIKKA_BYOS_INFISICAL_PATH
    const accessPath = process.env.MIKKA_BYOS_ACCESS_INFISICAL_PATH
    if (!databaseUrl || !canonicalGrantPath || !accessPath) throw new Error('subscription_binding_unavailable')
    return new EnrollmentClient({ ...enrollmentConfiguration(), databaseUrl, canonicalGrantPath, accessPath })
  },
})
