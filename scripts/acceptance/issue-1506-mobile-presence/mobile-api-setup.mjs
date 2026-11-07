// Additive, finite API setup check. No login, ticket/home read, socket, device
// mutation, model work, retry, timer loop or implicit executable entry point.
import { createHash } from 'node:crypto'
import { prepareMobilePresenceSource } from './source.mjs'
import { validateLiveTicket } from '../issue-1212-presence/presence-consumer.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA = /^[a-f0-9]{40}$/
const ref = value => createHash('sha256').update(value).digest('hex').slice(0, 12)
const channel = (ownerId, home) => createHash('sha256').update(JSON.stringify([ownerId, home])).digest('hex')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const requireValue = (value, code) => { if (!value) fail(code) }

function deviceIds(value, fixtureId) {
  requireValue(value && Array.isArray(value.threads) && Array.isArray(value.devices) && value.devices.length > 0
    && value.devices.every(row => UUID.test(row?.id ?? '') && typeof row.online === 'boolean')
    && value.devices.some(row => row.id === fixtureId && row.online === true), 'presence_mobile_data_invalid')
  const ids = value.devices.map(row => row.id.toLowerCase()).sort()
  requireValue(new Set(ids).size === ids.length, 'presence_mobile_devices_invalid')
  return ids
}

/** Corrupt the scope in the signed metadata; never sign it or treat the fake
 * home as an accessible workspace. The server must ignore this bad header. */
function wrongScopeToken(token, home) {
  let payload
  const [encoded, signature] = token.split('.')
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) } catch { fail('presence_mobile_home_payload_invalid') }
  requireValue(payload?.workspaceId === home, 'presence_mobile_home_payload_invalid')
  payload.workspaceId = home.slice(0, -1) + (home.endsWith('0') ? '1' : '0')
  return Buffer.from(JSON.stringify(payload)).toString('base64url') + '.' + signature
}

/** Call only from the existing authenticated after-run, before its idle phase.
 * `ticket` is an already obtained normal home ticket, retained in memory.
 * `initialRead` is the existing owned-device fixture snapshot, not a new read. */
export async function checkMobilePresenceSetup(session, {
  expectedSha = process.env.MIKKA_ACCEPTANCE_SHA, sourceRoot, ticket, initialRead, fixture,
  gatewayOrigin, phase, now = Date.now, signal, sourceLoader = prepareMobilePresenceSource,
} = {}) {
  requireValue(phase === 'setup-before-idle' && SHA.test(expectedSha ?? '') && session?.version?.build === expectedSha
    && typeof session?.identity?.userId === 'string' && typeof session.request === 'function', 'presence_mobile_context_invalid')
  const ownerId = session.identity.userId, home = initialRead?.live?.workspaceId
  requireValue(initialRead?.live?.ownerId === ownerId && UUID.test(home ?? '') && UUID.test(fixture?.deviceId ?? '')
    && initialRead.devices?.some(row => row.id === fixture.deviceId && row.online === true && row.enabled === false
      && row.name === fixture.marker && Array.isArray(row.harnesses) && row.harnesses.length === 0), 'presence_mobile_fixture_invalid')
  validateLiveTicket(ticket, ownerId, home, gatewayOrigin)
  requireValue(ticket.expiresAt - now() >= 60_000, 'presence_mobile_ticket_too_old')
  const source = await sourceLoader(sourceRoot)
  const cache = new source.ApiCache(); cache.setIdentity(ownerId)
  const proofs = new source.PresenceScopeCache(cache, now)
  const report = { schemaVersion: 1, case: 'mobile-presence-api-setup', applicationSha: expectedSha,
    sourceCommit: source.sourceCommit, sourceHashes: source.hashes, ownerRef: ref(ownerId), homeRef: ref(home),
    setupThreadReads: 0, addedTicketReads: 0, addedHomeReads: 0, mutations: 0, modelCalls: 0,
    actualClientProofHolder: true, phoneRendered: false, workerAcknowledgementChecked: false,
    signatureVerifiedLocally: false, cases: [] }
  try {
    proofs.remember(home, ticket, proofs.begin())
    const token = proofs.token(), homeProof = ticket.homeScope
    requireValue(token && token === homeProof?.token && homeProof.ownerId === ownerId && homeProof.workspaceId === home
      && homeProof.expiresAt <= ticket.expiresAt, 'presence_mobile_ticket_proof_invalid')
    const wrongScope = wrongScopeToken(token, home)
    let referenceIds
    for (const [name, header] of [['valid', token], ['absent', null], ['tampered-scope', wrongScope]]) {
      requireValue(!signal?.aborted, 'presence_mobile_setup_aborted')
      report.setupThreadReads++
      const response = await session.request('/api/mobile/threads', { method: 'GET',
        headers: header ? { 'x-mikka-presence-scope': header } : {},
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) })
      const value = await response.json().catch(() => null)
      requireValue(response.ok, 'presence_mobile_read_failed')
      const ids = deviceIds(value, fixture.deviceId)
      requireValue(value.live?.ownerId === ownerId, 'presence_mobile_owner_invalid')
      if (referenceIds) requireValue(JSON.stringify(ids) === JSON.stringify(referenceIds), 'presence_mobile_device_set_changed')
      else referenceIds = ids
      if (name === 'valid') {
        requireValue(value.live.workspaceId === home && typeof value.live.presence?.token === 'string'
          && value.live.presence.token.length <= 1900 && /^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(value.live.presence.token), 'presence_mobile_grant_invalid')
        let payload
        try { payload = JSON.parse(Buffer.from(value.live.presence.token.split('.')[0], 'base64url').toString('utf8')) } catch { fail('presence_mobile_grant_invalid') }
        const grant = source.presenceGrantPayload(payload, now())
        requireValue(grant && grant.channel === channel(ownerId, home) && grant.home === home
          && grant.expiresAt === value.live.presence.expiresAt && grant.expiresAt <= homeProof.expiresAt
          && JSON.stringify(grant.devices.map(row => row[0]).sort()) === JSON.stringify(ids)
          && grant.devices.every(([id, online]) => value.devices.find(row => row.id.toLowerCase() === id)?.online === online), 'presence_mobile_grant_scope_invalid')
        report.cases.push({ name, status: response.status, ownerMatched: true, homeMatched: true,
          deviceSetMatched: true, deviceCount: ids.length, deviceSetRef: ref(JSON.stringify(ids)), fixtureOnline: true,
          expiryBounded: true, grantRemainingMs: grant.expiresAt - now(), proofRemainingMs: homeProof.expiresAt - now() })
      } else {
        requireValue(value.live.workspaceId === null && value.live.presence === null, 'presence_mobile_invalid_scope_covered')
        report.cases.push({ name, status: response.status, ownerMatched: true, deviceSetMatched: true,
          deviceCount: ids.length, fixtureOnline: true, uncovered: true })
      }
    }
    report.status = 'passed'
    return report
  } finally { proofs.clear(); cache.clear(); source.close() }
}
