import { createHash } from 'node:crypto'
import { MIGRATION_HISTORY } from './migration-history.mjs'
import { readdirSync, readFileSync } from 'node:fs'

/** Test-only fail-closed preflight. This is not deletion authorization. A
 * passing text scan does not establish that arbitrary SQL/scripts are safe;
 * setup/teardown still require independent static review before execution. */
export function assertRetainOnlySql(sql, name = 'test SQL') {
  const audited = MIGRATION_HISTORY[name]
  // These seven exact files were reviewed: DELETE appears only in rejection
  // trigger declarations; they contain no executable destructive statements.
  if (audited && createHash('sha256').update(sql).digest('hex') === audited.sha256) return
  if (/\b(?:drop|delete|truncate)\b/i.test(sql)) blockDestructiveFixture(name)
}
export function blockDestructiveFixture(name) {
  throw new Error(`Test pending: ${name} has an unapproved destructive path. Resources must be retained; do not rerun this path.`)
}
/** Check the complete setup manifest before a test opens a database. Known
 * historical DROP files deliberately keep these fixtures pending. */
export function assertRetainedMigrationBootstrap() {
  const directory=new URL('../drizzle/',import.meta.url)
  for(const name of readdirSync(directory).filter(name=>name.endsWith('.sql')))
    assertRetainOnlySql(readFileSync(new URL(name,directory),'utf8'),name)
}
