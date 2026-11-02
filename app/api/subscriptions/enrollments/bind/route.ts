import { freshSessionRoute } from '@/lib/fresh-session'
import { auth } from '@/lib/api-auth'
import { pool } from '@/lib/db'
import { authorizeSubscriptionWorkspace } from '@/lib/subscription-runtime'
import { EnrollmentClient, enrollmentOperator } from '@/lib/subscription-enrollment'
import { enrollmentConfiguration } from '@/lib/subscription-enrollment-runtime'
import { enrollmentBindHTTP } from '@/lib/subscription-enrollment-bind'
import { byosEnrollmentEnabled } from '@/lib/cloud-computer-flag'
import { enrollmentBindingDatabaseIdentity, enrollmentBindingPage, verifyEnrollmentBindingProof } from '@/lib/subscription-enrollment-binding-proof'

export const runtime = 'nodejs'
export const maxDuration = 120
export const GET = () => byosEnrollmentEnabled() ? enrollmentBindingPage() : new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } })

const POSTBody = enrollmentBindHTTP({
  operator: async request => byosEnrollmentEnabled() ? enrollmentOperator(request, process.env.MIKKA_BYOS_ENROLLMENT_OPERATOR_TOKEN) : null,
  session: async request => {
    const session = await auth.api.getSession({ headers: request.headers })
    return session ? { userId: session.user.id, tokenWorkspaceId: session.tokenWorkspaceId } : null
  },
  handoff: async (request, ownerId, body) => {
    const operator = process.env.MIKKA_BYOS_ENROLLMENT_OPERATOR_TOKEN
    const databaseUrl = pool.options.connectionString
    if (!byosEnrollmentEnabled() || !operator || !databaseUrl || !body.proof) return null
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
    return new EnrollmentClient({ ...enrollmentConfiguration(), databaseUrl, canonicalGrantPath, accessPath, accessProject: process.env.MIKKA_BYOS_ACCESS_INFISICAL_PROJECT })
  },
})

// Credentials, permissions, money and deletion: the session is read from the database, not the cookie cache.
export const POST = freshSessionRoute(POSTBody)
