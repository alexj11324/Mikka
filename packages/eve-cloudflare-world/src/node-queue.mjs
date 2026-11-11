import { createCloudflareQueue } from '@fantasticfour/world-cloudflare'
import { parseQueueName, WORKFLOW_FLOW_ROUTE } from '@workflow/world/queue.js'
import { authenticateDelivery } from './queue-auth.mjs'
import { validRelease } from './queue-transport.mjs'

/** The Node host's private outbound intercept routes only world.internal to
 * the named WorldQueueService. The v5 executor owns all workflow processing. */
export function createNodeQueue({ deploymentId, fetchBound, signingKey, verificationKey }) {
  if (!validRelease(deploymentId)) throw new TypeError('Invalid Eve deployment id')
  function forRevision(revision, continuation = false) {
    if (!validRelease(revision)) throw new TypeError('Invalid target Eve deployment id')
    const request = async (path, init) => {
      const response = await fetchBound('https://world.internal' + path, init)
      if (!response.ok) throw new Error('Private World queue operation failed: ' + response.status)
      return response
    }
    let receipt
    const native = createCloudflareQueue({ nativeOnly: true, deploymentId: revision, env: {
      WORKFLOW_QUEUE: { async send(body, { delaySeconds = 0 } = {}) {
        const params = new URLSearchParams({ release: revision, delay: String(Math.ceil(delaySeconds)), continuation: String(continuation) })
        const result = await request('/world/queue/publish?' + params, { method: 'POST', body })
        receipt = await result.json()
      } },
      WORKFLOW_DB: {
        idFromName: key => key,
        get(key) {
          let owner
          return {
            async claimInflight({ messageId, staleMs }) {
              owner = messageId
              const result = await request('/world/queue/claim', { method: 'POST', body: JSON.stringify({ key, owner, staleMs }) })
              return result.json()
            },
            async releaseInflight() {
              await request('/world/queue/release', { method: 'POST', body: JSON.stringify({ key, owner }) })
            },
          }
        },
      },
    } })
    return {
      createQueueHandler: native.createQueueHandler,
      async queue(name, message, opts) {
        // The native binding derives its claim name with ':' separators. Encode
        // the opaque key so different queue-name/key pairs cannot alias.
        const key = opts?.idempotencyKey
        const normalized = key ? { ...opts, idempotencyKey: Buffer.from(JSON.stringify(key)).toString('base64url') } : opts
        await native.queue(name, message, normalized)
        return receipt
      },
    }
  }
  const local = forRevision(deploymentId, true)
  return {
    getDeploymentId: () => Promise.resolve(deploymentId),
    queue(queueName, message, opts) {
      parseQueueName(queueName)
      return forRevision(opts?.deploymentId ?? deploymentId).queue(queueName, message, opts)
    },
    createQueueHandler(prefix, handler) {
      const handle = local.createQueueHandler(prefix, async (message, meta) => {
        const result = await handler(message, meta)
        if (result && typeof result.timeoutSeconds === 'number' && !Number.isFinite(result.timeoutSeconds)) {
          throw new Error('Invalid workflow suspension duration')
        }
        return result
      })
      return async request => {
        const url = new URL(request.url)
        if (url.pathname !== WORKFLOW_FLOW_ROUTE || request.method !== 'POST' ||
            request.headers.get('x-mikka-eve-release') !== deploymentId) return new Response(null, { status: 409 })
        const body = await request.text()
        if (!await authenticateDelivery(verificationKey ?? signingKey, deploymentId, request.headers, body)) return new Response(null, { status: 403 })
        const response = await handle(new Request(url, { method: 'POST', headers: request.headers, body }))
        const receipt = new Response(response.body, response)
        receipt.headers.set('x-mikka-eve-release', deploymentId)
        return receipt
      }
    },
  }
}
