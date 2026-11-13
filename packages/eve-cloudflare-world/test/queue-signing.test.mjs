import { expect, test } from 'vitest'
import { consumeWorldQueue } from '../src/queue-transport.mjs'
import { authenticateDelivery } from '../src/queue-auth.mjs'

// Production Secrets Store keeps the typed key. Earlier staging stored bare
// PKCS8 base64; both must reach the same authenticated executor boundary.
test.each(['eve', 'business'].flatMap(workload => ['typed', 'bare'].map(format => ({ workload, format }))))(
  'delivers $workload queue entries with a $format Ed25519 Secrets Store key', async ({ workload, format }) => {
    const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
    const privateKey = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64')
    const publicKey = 'ed25519-public:' + Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64')
    const revision = 'aaa1111-10-1'
    const body = JSON.stringify({ messageId: 'signing-regression', queueName: '__wkf_workflow_session' })
    let delivered = 0, acknowledged = 0, retried = 0
    const env = {
      WORLD_WORKLOAD: workload,
      WORLD_QUEUE_ED25519_PRIVATE_KEY: { get: async () => format === 'typed' ? 'ed25519-pkcs8:' + privateKey : privateKey },
      EVE_RELEASES: { [revision]: 'PINNED_EXECUTOR' },
      PINNED_EXECUTOR: { async fetch(request) {
        const received = await request.text()
        expect(received).toBe(body)
        expect(await authenticateDelivery(publicKey, revision, request.headers, received, workload)).toBe(true)
        delivered++
        return new Response(null, { status: 204, headers: { 'x-mikka-eve-release': revision } })
      } },
    }
    await consumeWorldQueue({ messages: [{
      body: { revision, dueAt: Date.now() - 1000, body }, attempts: 1,
      ack() { acknowledged++ }, retry() { retried++ },
    }] }, env)
    expect({ delivered, acknowledged, retried }).toEqual({ delivered: 1, acknowledged: 1, retried: 0 })
  },
)
