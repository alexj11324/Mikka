import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { writeJsonAtomic } from './fs-util'

/** Readiness notification only. The host still checks the current server-side
 * token and provisioning lease before marking a machine running. */
export function writeCloudRegistration(dataDir: string, deviceId: string, workspaceId: string, credential: string) {
  writeJsonAtomic(join(dataDir, 'registration.json'), {
    version: 1, deviceId, workspaceId,
    tokenSha256: createHash('sha256').update(credential).digest('hex'),
  })
}
