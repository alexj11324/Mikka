import { createHash } from 'node:crypto'

// Original failed owner request, bound to Core run 42612612253 and its actual
// e78fccf deployment. The device remains only a candidate until the normal
// owner token inventory proves its recorded association below.
export const CORE_1826_RECOVERY = Object.freeze({
  sourceRunId: 42612612253,
  sourceRevision: 'e78fccffd9dd878edd490b113ea80efcff1525e7',
  credentialId: '69c44f98f64244c0f2b56169524970950515c0d0523a2dfbbee36b40d67d1f33',
  deviceId: '469dab8ab0ef2a02ddc3b51ad5ab5286839e0836c16a032391d24d1a703867ce',
})
const fingerprint = (kind, value) => createHash('sha256').update(kind + '\0' + value).digest('hex')
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
class RecoveryError extends Error { constructor(code) { super(code); this.code = code } }
const check = (ok, code) => { if (!ok) throw new RecoveryError(code) }
const tokenIdentity = value => JSON.stringify([value.id, value.name, value.createdAt, value.expiresAt,
  value.revokedAt, value.revokedBy, value.boundDeviceId, value.deviceIds])
const deviceIdentity = value => JSON.stringify([value.id, value.name, value.hostname, value.platform, value.arch,
  value.enabled, value.harnesses, value.repos])

function active(token, now) {
  check(token.revokedAt === null || timestamp(token.revokedAt), 'recovery_metadata')
  check(token.expiresAt === null || timestamp(token.expiresAt), 'recovery_metadata')
  return token.revokedAt === null && (token.expiresAt === null || Date.parse(token.expiresAt) > now())
}
function inventory(rows) {
  check(Array.isArray(rows) && rows.every(row => uuid(row.id)) && new Set(rows.map(row => row.id)).size === rows.length, 'recovery_metadata')
  return rows
}
function links(token) {
  check(Array.isArray(token.deviceIds) && token.deviceIds.every(uuid)
    && new Set(token.deviceIds).size === token.deviceIds.length, 'recovery_links_unavailable')
  return token.deviceIds
}

/** The caller supplies only its already-attested normal-owner API operations.
 * No SQL, credential reconstruction, name/time guessing or extra login exists
 * here. An unavailable original bearer is never reported as a tested 401. */
export async function recoverCoreCleanup({ ownerId, listTokens, listDevices, revokeToken, removeDevice,
  verifyTarget, now = Date.now, anchor = CORE_1826_RECOVERY }) {
  const report = { version: 1, scope: 'core-1826-owner-recovery', status: 'fail', anchor,
    credentialDatabaseStateBefore: null, credentialRevoked: false, revokedByOwner: null,
    credentialRevocationEvidence: 'normal_owner_metadata_readback',
    originalBearerRejection: 'not_exercised_original_credential_unavailable',
    deviceAssociationConfirmed: false, deviceDisposition: null,
    originalCredentialsPreserved: false, originalDevicesPreserved: false, errors: [] }
  try {
    check(typeof ownerId === 'string' && ownerId.length > 0, 'recovery_owner')
    await verifyTarget()
    const beforeTokens = inventory(await listTokens())
    const matches = beforeTokens.filter(row => fingerprint('device-token-id', row.id) === anchor.credentialId)
    check(matches.length === 1, 'recovery_token_not_unique')
    const original = matches[0], tokenId = original.id
    report.credentialDatabaseStateBefore = original.revokedAt !== null ? 'revoked' : active(original, now) ? 'active' : 'expired'
    // Close the exact credential first, even if a later association check is
    // unavailable or ambiguous. The other credentials are never candidates.
    if (original.revokedAt === null) {
      await verifyTarget()
      const receipt = await revokeToken(tokenId)
      check(receipt?.tokenId === tokenId && receipt.revokedBy === ownerId && timestamp(receipt.revokedAt), 'recovery_revoke_failed')
    }
    const afterRevoke = inventory(await listTokens()), revoked = afterRevoke.find(row => row.id === tokenId)
    check(revoked && timestamp(revoked.revokedAt), 'recovery_revoke_readback')
    report.credentialRevoked = true
    report.revokedByOwner = revoked.revokedBy === ownerId
    const linked = links(revoked)
    check(linked.length === 1 && fingerprint('device-id', linked[0]) === anchor.deviceId, 'recovery_device_association')
    const deviceId = linked[0]
    report.deviceAssociationConfirmed = true
    const beforeDevices = inventory(await listDevices())
    const device = beforeDevices.find(row => row.id === deviceId)
    if (device) {
      // This acceptance registered a disabled, empty, transient device. If it
      // has acquired real work or another live credential, preserve it.
      check(device.enabled === false && device.online === false && Array.isArray(device.harnesses)
        && device.harnesses.length === 0 && Array.isArray(device.repos) && device.repos.length === 0, 'recovery_device_changed')
      await verifyTarget()
      const current = inventory(await listTokens()), stillRevoked = current.find(row => row.id === tokenId)
      check(stillRevoked && timestamp(stillRevoked.revokedAt)
        && links(stillRevoked).length === 1 && stillRevoked.deviceIds[0] === deviceId, 'recovery_device_association')
      check(!current.some(row => row.id !== tokenId && links(row).includes(deviceId) && row.revokedAt === null), 'recovery_other_unrevoked_credential')
      const receipt = await removeDevice(deviceId)
      check(receipt?.id === deviceId && receipt.uninstall === 'not_possible' && receipt.revokedTokens === 0, 'recovery_remove_failed')
      report.deviceDisposition = 'removed_by_normal_owner'
    } else report.deviceDisposition = 'already_absent_from_active_owner_list'
    const afterTokens = inventory(await listTokens()), afterDevices = inventory(await listDevices())
    const final = afterTokens.find(row => row.id === tokenId)
    check(final && timestamp(final.revokedAt) && links(final).includes(deviceId), 'recovery_revoke_readback')
    check(!afterDevices.some(row => row.id === deviceId), 'recovery_remove_readback')
    report.originalCredentialsPreserved = beforeTokens.filter(row => row.id !== tokenId).every(row =>
      afterTokens.some(next => next.id === row.id && tokenIdentity(next) === tokenIdentity(row)))
    const protectedDevices = beforeDevices.filter(row => row.id !== deviceId)
    report.originalDevicesPreserved = afterDevices.length === protectedDevices.length && protectedDevices.every(row =>
      afterDevices.some(next => next.id === row.id && deviceIdentity(next) === deviceIdentity(row)))
    check(report.originalCredentialsPreserved && report.originalDevicesPreserved, 'recovery_baseline_changed')
    await verifyTarget()
    report.status = 'pass'
  } catch (cause) {
    report.errors.push({ code: cause instanceof RecoveryError ? cause.code : 'recovery_operation_failed' })
  }
  return report
}
