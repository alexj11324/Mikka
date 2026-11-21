import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateHistoricalReleaseManifest, validateReleaseManifest } from './service-builds.mjs'

// Deploy dependencies before their callers. Migrations are a separate step
// before this list; retained services never reach a deployment writer.
export const deploymentOrder = ['world', 'task', 'litellm', 'eve', 'api', 'web']

/** Compare verified immutable deployment units, not the release commit or tag.
 * The private publisher owns environment selection, execution and receipts. */
export function planServiceRelease(currentManifest, nextManifest) {
  // Only an explicit null starts the first manifest-driven release. The private
  // publisher must capture the real previous deployment before any writer runs.
  const current = currentManifest === null ? null : validateHistoricalReleaseManifest(currentManifest)
  const next = validateReleaseManifest(nextManifest)
  const migrationFiles = new Set(next.migrations.files)
  assert.ok(!current || current.migrations.files.every(file => migrationFiles.has(file)),
    'A service release cannot remove previously released migrations')
  return compareServices(current, next)
}

/** Only the rollback handler may compare previously authenticated artifacts.
 * This describes old services; it never authorizes running or removing SQL.
 * The rollback writer keeps the already-applied additive database schema. */
export function planHistoricalServiceRelease(currentManifest, nextManifest) {
  const current = currentManifest === null ? null : validateHistoricalReleaseManifest(currentManifest)
  const next = validateHistoricalReleaseManifest(nextManifest)
  return compareServices(current, next)
}

function compareServices(current, next) {
  const services = Object.fromEntries(deploymentOrder.map(name => [name, {
    changed: !current || current.services[name].digest !== next.services[name].digest,
    before: current?.services[name] ?? null,
    after: next.services[name],
  }]))
  const changedServices = deploymentOrder.filter(name => services[name].changed)
  const retainedServices = deploymentOrder.filter(name => !services[name].changed)
  return {
    version: 1,
    bootstrap: current === null,
    sourceCommit: next.sourceCommit,
    previousSourceCommit: current?.sourceCommit ?? null,
    changedServices,
    retainedServices,
    deploymentOrder: changedServices,
    services,
    migrations: {
      changed: !current || current.migrations.version !== 2 || current.migrations.contextDigest !== next.migrations.contextDigest,
      before: current?.migrations ?? null,
      after: next.migrations,
    },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [currentPath, nextPath, outputPath, ...extra] = process.argv.slice(2)
  assert.ok(currentPath && nextPath && outputPath && extra.length === 0,
    'Usage: service-diff.mjs CURRENT_MANIFEST NEXT_MANIFEST OUTPUT')
  const [current, next] = await Promise.all([currentPath, nextPath].map(async path =>
    JSON.parse(await readFile(resolve(path), 'utf8'))))
  const plan = planServiceRelease(current, next)
  await writeFile(resolve(outputPath), JSON.stringify(plan, null, 2) + '\n')
  console.log(JSON.stringify({ sourceCommit: plan.sourceCommit,
    changedServices: plan.changedServices, retainedServices: plan.retainedServices,
    migrationsChanged: plan.migrations.changed }))
}
