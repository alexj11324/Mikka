import { createBoundFetch } from './bound-fetch.mjs'
import { createNodeWorld } from './node-world.mjs'

/** The same official World interface, limited by the private outbound binding
 * to this product-workflow workload. The business container only verifies
 * delivery signatures. It never receives the queue's private signing key. */
export function createWorld() {
  const publicKey = process.env.MIKKA_WORKFLOW_QUEUE_PUBLIC_KEY
  if (typeof publicKey !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(publicKey)) {
    throw new Error('Business workflow delivery verification key unavailable')
  }
  return createNodeWorld({ workload: 'business', deploymentId: process.env.MIKKA_DEPLOYMENT_ID,
    verificationKey: 'ed25519-public:' + publicKey, fetchBound: createBoundFetch(process.env.MIKKA_BUSINESS_WORLD_TOKEN) })
}
