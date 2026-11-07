import { createHash } from 'node:crypto'
import { liveInvalidation, liveReadiness } from '../../lib/live/events.ts'
import { openDeviceGateway, DEVICE_GATEWAY_PING } from '../../packages/daemon/src/device-gateway.ts'

export const CORE_RPC_ACTIONS = Object.freeze(['desktop.bootstrap', 'billing.getBilling'])
const gateways = new Set(['wss://mikka-gateway.aspectlylabs.com', 'wss://mikka-device-gateway.orvilo-preview.workers.dev'])
const codes = new Set(['core_discovery', 'core_features', 'core_billing', 'core_ticket', 'core_socket', 'core_live_event'])
const details = new Set(['shape', 'version', 'edition', 'identity', 'flags', 'configuration', 'scope', 'origin', 'protocol', 'expiry', 'open', 'ready', 'device_list', 'pong', 'closed', 'error', 'cleanup'])
export class CoreProbeError extends Error {
  constructor(code, detail, options) {
    super(codes.has(code) ? code : 'core_socket', options)
    this.name = 'CoreProbeError'; this.code = this.message
    this.detail = details.has(detail) ? detail : 'shape'
  }
}
const check = (value, code, detail) => { if (!value) throw new CoreProbeError(code, detail) }

/** Existing business reads only. HostedUsage/CardStatus reads can migrate legacy
 * billing rows, so those are deliberately outside this transport acceptance. */
export async function readCoreCapabilities({ owner, rpc, ownerId, workspaceId, role, applicationSha }) {
  const discovery = await owner('/api/desktop/discovery')
  const data = discovery.body
  check(discovery.status === 200 && data && data.basePath === '/mikka'
    && Number.isSafeInteger(data.desktopProtocol?.min) && Number.isSafeInteger(data.desktopProtocol?.max)
    && data.desktopProtocol.min <= 1 && data.desktopProtocol.max >= 1
    && typeof data.cloud?.connected === 'boolean' && data.mobileReady === true
    && ['google', 'github', 'email'].every(name => typeof data.signIn?.[name] === 'boolean'), 'core_discovery', 'shape')
  check(data.version === applicationSha, 'core_discovery', 'version')
  check(data.edition === 'cloud', 'core_discovery', 'edition')
  const bootstrap = await rpc('desktop.bootstrap', [workspaceId])
  check(bootstrap?.user?.id === ownerId && bootstrap.cacheWorkspace?.workspaceId === workspaceId
    && bootstrap.cacheWorkspace.role === role && bootstrap.edition === 'cloud', 'core_features', 'identity')
  const flags = bootstrap.features?.flags
  check(flags && typeof flags === 'object' && !Array.isArray(flags) && Object.values(flags).every(value => typeof value === 'boolean')
    && bootstrap.features.cloudComputer === true && flags['mikka-computer-billing'] === false
    && flags['mikka-computer-tab-off'] === false && bootstrap.emailEnabled === true, 'core_features', 'flags')
  const billing = { status: 'not_authorized', configured: null, quotaEnforcementExercised: false, settlementExercised: false }
  if (role === 'admin') {
    const view = await rpc('billing.getBilling', [workspaceId])
    check(view?.configured === true && typeof view.live === 'boolean' && typeof view.hasCustomer === 'boolean'
      && Number.isSafeInteger(view.seats) && Number.isSafeInteger(view.members)
      && Number.isFinite(view.purchasedPoints), 'core_billing', 'configuration')
    billing.status = 'read'; billing.configured = true
  }
  return { discovery: { edition: 'cloud', versionMatches: true, mobileReady: true, cloudConnected: data.cloud.connected,
    signIn: { google: data.signIn.google, github: data.signIn.github, email: data.signIn.email } },
    flags: { cloudComputer: true, computerBilling: false, computerTabDisabled: false, emailSignIn: true }, billing }
}

function ticket(value, path, now) {
  let url
  try { url = new URL(value?.url) }
  catch (cause) { throw new CoreProbeError('core_ticket', 'origin', { cause }) }
  check(gateways.has(url.origin) && !url.username && !url.password && !url.search && !url.hash
    && url.pathname === path, 'core_ticket', 'origin')
  const protocol = /^mikka-ticket-([0-9]+)-[a-f0-9]{64}$/.exec(value.protocol ?? '')
  check(protocol, 'core_ticket', 'protocol')
  const expiry = Number(protocol[1]) * 1000
  // The server issues five-minute tickets. Allow small cross-host clock skew;
  // this observation does not validate the signature or extend its authority.
  check(Number.isSafeInteger(expiry) && expiry > now() && expiry <= now() + 305_000, 'core_ticket', 'expiry')
  if (value.expiresAt !== undefined) check(value.expiresAt === expiry, 'core_ticket', 'expiry')
  return { url: url.href, protocol: value.protocol }
}

/** Bounded event waits, never a read/poll loop. Only closed observations survive. */
function socketProof(target, { socketFactory = openDeviceGateway, timeoutMs = 20_000, workspaceId } = {}) {
  let socket
  try { socket = socketFactory(target.url, target.protocol) }
  catch (cause) { throw new CoreProbeError('core_socket', 'open', { cause }) }
  const state = { open: false, ready: false, deviceLists: 0, pong: false }
  let failed
  const waiters = new Set()
  const update = () => { for (const waiter of waiters) waiter() }
  const listeners = [
    ['open', () => { state.open = true; update() }],
    ['message', event => {
      if (event.data === 'pong') { state.pong = true; update(); return }
      if (typeof event.data !== 'string' || event.data.length > 32_000) return
      let frame
      try { frame = JSON.parse(event.data) } catch { return }
      const ready = liveReadiness(frame)
      if (ready?.kinds.includes('device_list')) state.ready = true
      const eventKey = liveInvalidation(frame, true)
      if (workspaceId && eventKey?.kind === 'device_list' && eventKey.id === workspaceId) state.deviceLists++
      update()
    }],
    ['close', () => { failed ??= new CoreProbeError('core_socket', 'closed'); update() }],
    ['error', () => { failed ??= new CoreProbeError('core_socket', 'error'); update() }],
  ]
  for (const [name, listener] of listeners) socket.addEventListener(name, listener)
  function wait(predicate, detail) {
    return new Promise((resolve, reject) => {
      let timer
      const finish = error => { clearTimeout(timer); waiters.delete(observe); if (error) reject(error); else resolve() }
      const observe = () => { if (failed) finish(failed); else if (predicate()) finish() }
      timer = setTimeout(() => finish(new CoreProbeError('core_socket', detail)), timeoutMs)
      waiters.add(observe); observe()
    })
  }
  return {
    ready: () => wait(() => state.open && state.ready, 'ready'),
    expectDeviceList() {
      const before = state.deviceLists
      // Attach rejection handling before the register request. A lost/slow
      // response must not turn this bounded wait into an unhandled rejection.
      const receipt = wait(() => state.deviceLists > before, 'device_list').then(() => null, error => error)
      return async () => { const error = await receipt; if (error) throw error }
    },
    async ping() {
      await wait(() => state.open, 'open')
      const pong = wait(() => state.pong, 'pong')
      try { socket.send(DEVICE_GATEWAY_PING) }
      catch (cause) { failed = new CoreProbeError('core_socket', 'error', { cause }); update() }
      await pong
    },
    async close() {
      try {
        if (socket.readyState === 3) return
        await new Promise((resolve, reject) => {
          const done = () => { clearTimeout(timer); socket.removeEventListener?.('close', done); resolve() }
          const timer = setTimeout(() => { socket.removeEventListener?.('close', done); reject(new CoreProbeError('core_socket', 'cleanup')) }, Math.min(timeoutMs, 3_000))
          socket.addEventListener('close', done)
          try { socket.close() }
          catch (cause) { clearTimeout(timer); socket.removeEventListener?.('close', done); reject(new CoreProbeError('core_socket', 'cleanup', { cause })) }
        })
      } finally {
        failed ??= new CoreProbeError('core_socket', 'closed'); update()
        for (const [name, listener] of listeners) socket.removeEventListener?.(name, listener)
      }
    },
  }
}

export function coreLiveSocket(value, { ownerId, workspaceId, now = Date.now, ...options }) {
  check(typeof ownerId === 'string' && /^[0-9a-f-]{36}$/i.test(workspaceId), 'core_ticket', 'scope')
  const channel = createHash('sha256').update(JSON.stringify([ownerId, workspaceId])).digest('hex')
  return socketProof(ticket(value, '/v1/live/' + channel + '/socket', now), { ...options, workspaceId })
}

export function coreDeviceSocket(value, { deviceId, now = Date.now, ...options }) {
  check(/^[0-9a-f-]{36}$/i.test(deviceId)
    && ['runControl', 'computerReviews', 'coordinatorResults'].every(name => value?.[name] === 'push'), 'core_ticket', 'shape')
  return socketProof(ticket(value, '/v1/devices/' + deviceId + '/socket', now), options)
}
