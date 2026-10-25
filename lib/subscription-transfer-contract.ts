import { z } from 'zod'

const store = z.object({
  origin: z.literal('https://app.infisical.com'),
  projectId: z.literal('89850d6a-f020-4936-863e-df77380dfe40'),
  environment: z.enum(['staging', 'prod']),
  grantPath: z.string().regex(/^\/byos\/(pending-grants|grants)$/),
}).strict()
/** Approval metadata only. No token, URL credential, source blob or login session. */
export const subscriptionTransferApproval = z.object({
  transferId: z.uuid(), enrollmentId: z.uuid(),
  ownerId: z.string().min(1).max(128), workspaceId: z.uuid(),
  sourcePrincipal: z.string().regex(/^operator:[a-f0-9]{64}$/),
  provider: z.literal('claude'), providerSubject: z.string().min(1).max(256),
  source: store, destination: store,
  destinationOrigin: z.literal('https://app.aspectlylabs.com'),
  destinationDatabaseIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), sourceRevision: z.literal(1),
  expiresAt: z.iso.datetime(), deleteSource: z.literal(false),
}).strict()
export function validateSubscriptionTransferApproval(value: unknown, actor: {
  ownerId: string; workspaceId: string; databaseIdentity: string; origin: string
}, now = Date.now()) {
  const approval = subscriptionTransferApproval.parse(value)
  const expiry = Date.parse(approval.expiresAt)
  if (approval.ownerId !== actor.ownerId || approval.workspaceId !== actor.workspaceId ||
    approval.destinationDatabaseIdentity !== actor.databaseIdentity || approval.destinationOrigin !== actor.origin ||
    expiry <= now || expiry > now + 15 * 60_000 || approval.source.environment !== 'staging' ||
    approval.destination.environment !== 'prod' || approval.source.grantPath !== '/byos/pending-grants' ||
    approval.destination.grantPath !== '/byos/grants') throw new Error('subscription_transfer_not_authorized')
  return approval
}
// The server loads this manifest from controlled configuration, never request
// JSON. The worker journals its digest before reads and alone decides whether an
// expired approval is an identical durable recovery, rather than a new transfer.
