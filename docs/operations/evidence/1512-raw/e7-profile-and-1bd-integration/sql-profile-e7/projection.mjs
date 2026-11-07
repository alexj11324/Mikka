import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { queryCountDelta } from './metrics/lifecycle-query-counts.mjs'
import { check } from './reads.mjs'

export const CLOSED_LABELS_SHA256 = 'dd352c9f91b3a1588d989ce974fbf5959c2107b790c234382364e03653812017'
export const METRICS_BODY_MAX_BYTES = 32768
const root = dirname(fileURLToPath(import.meta.url))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

// Check both original source files and the reviewed diagnostic copies before
// preload. The product .output and its manifest are never patched.
export async function verifyInstrumentation(source, expected) {
  const raw = await readFile(join(root, 'closed-labels.json'))
  check(sha256(raw) === CLOSED_LABELS_SHA256, 'CLOSED_LABELS_DIGEST_MISMATCH')
  const table = JSON.parse(raw)
  check(table.sourceHead === expected.candidate && table.sourceTree === expected.tree
    && table.compiledRevision === expected.source && table.exactRouteHashMatch === true
    && table.reconstructedRoutesSha256 === table.compiledRoutesSha256
    && table.queryUnattributedSources.length === 287, 'CLOSED_LABELS_SOURCE_MISMATCH')
  const manifest = JSON.parse(await readFile(join(source, '.output/mikka-build.json'), 'utf8'))
  check(manifest.revision === expected.source && manifest.routesSha256 === table.compiledRoutesSha256
    && /^v24\.[0-9]+\.[0-9]+$/.test(manifest.node ?? ''), 'COMPILED_ROUTE_CATALOG_MISMATCH')
  const proof = JSON.parse(await readFile(join(root, 'metrics-provenance.json'), 'utf8'))
  check(proof.source === expected.candidate && proof.compiledSource === expected.source && proof.tree === expected.tree
    && proof.closedLabelsSha256 === CLOSED_LABELS_SHA256 && proof.files.length === 4
    && new Set(proof.files.map(file => file.path)).size === 4, 'INSTRUMENTATION_PROVENANCE_INVALID')
  for (const file of proof.files) {
    check(['metrics/db-metrics.cjs', 'metrics/db-query-operations.cjs', 'metrics/db-query-unattributed-sources.cjs', 'metrics/lifecycle-query-counts.mjs'].includes(file.path)
      && file.sourcePath === `apps/desktop/test/${file.path.split('/')[1]}`, 'INSTRUMENTATION_PATH_INVALID')
    const [original, copied] = await Promise.all([readFile(join(source, file.sourcePath)), readFile(join(root, file.path))])
    check(original.length === file.sourceBytes && sha256(original) === file.sourceSha256
      && copied.length === file.bytes && sha256(copied) === file.sha256, 'INSTRUMENTATION_SOURCE_MISMATCH')
  }
  return { ...proof, status: 'source_and_copies_verified', closedLabels: 'closed-labels.json',
    compiledRoutesSha256: manifest.routesSha256, compiledNode: manifest.node,
    projection: 'all snapshot maps are validated in full before nonzero delta projection; omitted approved labels are exactly zero',
    descriptorMaxBytes: 8192, metricsBodyMaxBytes: METRICS_BODY_MAX_BYTES,
    rawLogReadInvoked: false, rawScopeExported: false, sqlExported: false,
    otherScopedMeaning: 'an actual non-null label outside the fixed source allowlist; not a dropped query',
    noScopeMeaning: 'no actual AsyncLocalStorage label at query invocation',
  }
}

export function compactSnapshot(snapshot) {
  return Object.fromEntries(['version', 'runtime', 'pid', 'startedAt', 'endedAt', 'instrumentedClients', 'queryCalls',
    'pgProtocolReceiveBytes', 'pgProtocolSendBytes', 'activeConnections', 'closedConnections', 'unknownReadings']
    .map(key => [key, snapshot[key]]))
}

export function profileDelta(before, after) {
  // The original delta rejects resets, PID/time changes, negative per-label
  // differences, unknown stream readings and both conservation violations.
  const value = queryCountDelta(before, after)
  check(value.queryOperations && value.unattributedSources, 'COUNTER_MAPS_REQUIRED')
  const nonzero = counts => Object.fromEntries(Object.entries(counts).filter(([, count]) => count !== 0))
  return { ...value, queryOperations: nonzero(value.queryOperations), unattributedSources: nonzero(value.unattributedSources) }
}
