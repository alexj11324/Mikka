import { EnvironmentError, localDatabaseTarget } from './database-target.mjs'

// These are the two disposable resources authorized for issue #1415. A DNS
// suffix, an environment flag or an arbitrary descriptor cannot add a resource.
const SANDBOXES = new Set([
  'sbx_001m6p8qt9pcng01mwgkmshdz6m',
  'sbx_001m6p98ev958vppx9366vfp8ea',
])
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/

export function dockerOrigin(sandboxUid, port) {
  if (!SANDBOXES.has(sandboxUid) || port !== 3000) throw new EnvironmentError('DOCKER_TARGET_FORBIDDEN')
  return `https://${port}-${sandboxUid.slice(4)}.sbx.sandboxes-cloud.docker.com`
}

export function validateDockerBinding(binding, origin) {
  if (!binding || dockerOrigin(binding.sandboxUid, binding.port) !== origin || !UUID.test(binding.publicationUid ?? '')) throw new EnvironmentError('DOCKER_PUBLICATION_MISMATCH')
  return Object.freeze({ sandboxUid: binding.sandboxUid, port: binding.port, publicationUid: binding.publicationUid })
}

export function dockerDatabaseTarget(connectionString) {
  const database = localDatabaseTarget(connectionString)
  if (database.host !== '127.0.0.1' || database.port !== 5432 || database.user !== 'e2e') throw new EnvironmentError('DOCKER_DATABASE_FORBIDDEN')
  return Object.freeze(database)
}
