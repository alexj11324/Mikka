import { createHash } from 'node:crypto'
import { latestDefaultCandidates, type EntrySource, type OrderHarness, type RunLocation } from '../../../lib/model-order-plan'

type OrderSnapshot = {
  location: RunLocation; preferredHarness: OrderHarness; autoModelRouting: boolean; customized: boolean
  entries: { harness: OrderHarness; model: string; source: EntrySource }[]
}
const WORKSPACE_ID = '93f38d33-9447-4eaf-8a46-0d8889165bcd'
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const serialized = (value: any) => JSON.stringify(canonical(value))
function briefOrder(value: any): OrderSnapshot | null {
  if (!value || !['cloud', 'local'].includes(value.location) || !['claude_code', 'codex'].includes(value.preferredHarness)
    || typeof value.autoModelRouting !== 'boolean' || typeof value.customized !== 'boolean' || !Array.isArray(value.entries)
    || value.entries.some((entry: any) => !entry || !['claude_code', 'codex'].includes(entry.harness) || typeof entry.model !== 'string'
      || !entry.source || (entry.source.kind === 'subscription' ? typeof entry.source.connectionId !== 'string'
        : entry.source.kind !== 'api_key' || typeof entry.source.keyId !== 'string'))) return null
  return { location: value.location, preferredHarness: value.preferredHarness, autoModelRouting: value.autoModelRouting,
    customized: value.customized, entries: value.entries.map((entry: any) => ({ harness: entry.harness, model: entry.model, source: entry.source })) }
}
export function sameModelOrder(value: unknown, expected: unknown): boolean {
  const actual = briefOrder(value), desired = briefOrder(expected)
  return actual !== null && desired !== null && serialized(actual) === serialized(desired)
}
const effectiveOrder = (value: OrderSnapshot) => serialized({ ...value, customized: undefined })

/** Evidence for this fixture only. Project its pinned old defaults with the
 * product resolver; never write either list back as a replacement default. */
function receiptModelOrderCleanupPlan(initial: any, latest: any, now: number, expectedStatus: 'passed' | 'failed') {
  const original = briefOrder(initial?.originalOrder)
  const started = briefOrder(latest?.originalOrder), materialized = briefOrder(latest?.restoredOrder)
  const validReceipt = (value: any) => value?.issue === 1503 && value.workspaceId === WORKSPACE_ID
    && value.phase === 'delivery' && value.repository === 'alexj11324/Mikka-handoff'
    && Number.isFinite(Date.parse(value.startedAt)) && Number.isFinite(Date.parse(value.completedAt))
    && Date.parse(value.completedAt) >= Date.parse(value.startedAt)
  const refuse = (): never => { throw new Error('issue1503_cleanup_model_order_receipt_mismatch') }
  if (!validReceipt(initial) || initial.marker !== '42278720813-1' || !original || original.customized !== false
    || createHash('sha256').update(serialized(initial.originalOrder)).digest('hex') !== '528cdc4ffd615042e48ab112b9132779f328637e0469364e71f9cbc22a590792'
    || !validReceipt(latest) || latest.status !== expectedStatus || Date.parse(latest.startedAt) < Date.parse(initial.completedAt)
    || Date.parse(latest.completedAt) > now + 30_000
    || !Array.isArray(latest.cleanup) || !latest.cleanup.some((entry: any) => entry?.kind === 'effective_model_order_restored')
    || !started || !materialized) return refuse()
  const currentDefault: OrderSnapshot = { ...original, entries: latestDefaultCandidates(original.entries.map(entry => ({ ...entry, name: entry.model })))
    .map(({ harness, model, source }) => ({ harness, model, source })) }
  // A driver may start with the first run's materialized 22 entries or the new
  // eight-entry default. Its own before/after evidence must still agree exactly.
  if (effectiveOrder(started) !== effectiveOrder(materialized)
    || (effectiveOrder(materialized) !== effectiveOrder(original) && effectiveOrder(materialized) !== effectiveOrder(currentDefault))) return refuse()
  return { original, materialized, currentDefault }
}

/** The original final-C behavior remains PASS-only. */
export function modelOrderCleanupPlan(initial: any, latest: any, now = Date.now()) {
  return receiptModelOrderCleanupPlan(initial, latest, now, 'passed')
}

/** The failed-release caller supplies the two SHA-bound original F186 reports.
 * Preserve their real failure status and use the actual latest writer window. */
export function failedReleaseModelOrderCleanupPlan(initial: any, failures: any[], now = Date.now()) {
  const refuse = (): never => { throw new Error('issue1503_cleanup_failed_model_order_receipt_mismatch') }
  if (!Array.isArray(failures) || failures.length !== 2) return refuse()
  const plans = failures.map((latest, index) => {
    const started = briefOrder(latest?.originalOrder), restored = briefOrder(latest?.restoredOrder)
    if (latest?.status !== 'failed' || latest.marker !== '42535538611-1'
      || latest.expectedSha !== 'bb5d1f9e224aea395b9c45823960e8ad10f1a099'
      || serialized(latest.selectedHarnesses) !== serialized([index === 0 ? 'claude_code' : 'codex'])
      || !started || !restored || started.entries.length !== 22 || restored.entries.length !== 22
      || started.location !== 'cloud' || started.preferredHarness !== 'claude_code'
      || started.autoModelRouting !== true || started.customized !== true
      || !sameModelOrder(started, restored)
      || !Array.isArray(latest.cleanup) || !latest.cleanup.some((entry: any) =>
        entry?.kind === 'effective_model_order_restored' && entry.customizedFlagPreserved === true)) return refuse()
    return receiptModelOrderCleanupPlan(initial, latest, now, 'failed')
  })
  if (Date.parse(failures[0].completedAt) >= Date.parse(failures[1].startedAt)
    || !sameModelOrder(failures[0].restoredOrder, failures[1].originalOrder)) return refuse()
  return { ...plans[1], latest: failures[1] }
}

/** This run restored the actual eight-entry default; its first leg changed
 * only the materialized flag. Preserve that false receipt, never reinterpret it
 * as F186's true flag or a successful delivery. The caller verifies raw bytes. */
export function f42606137512ModelOrderCleanupPlan(initial: any, failures: any[], now = Date.now()) {
  const refuse = (): never => { throw new Error('issue1503_cleanup_f42606137512_model_order_receipt_mismatch') }
  if (!Array.isArray(failures) || failures.length !== 2) return refuse()
  const pins = [
    { harness: 'claude_code', startedAt: '2026-11-09T11:06:16.907Z', completedAt: '2026-11-09T11:08:49.324Z',
      originalCustomized: false, flagPreserved: false,
      originalHash: '9b8296bd6449841656e279bb6287feea84899c47aaea468ffe1a44f3d76400fb' },
    { harness: 'codex', startedAt: '2026-11-09T11:08:52.863Z', completedAt: '2026-11-09T11:13:17.885Z',
      originalCustomized: true, flagPreserved: true,
      originalHash: '483e54d0f2281589293466e1be05347baf93e30b008f05454fe61bd1a19233a2' },
  ]
  const restoredHash = '483e54d0f2281589293466e1be05347baf93e30b008f05454fe61bd1a19233a2'
  const plans = failures.map((latest, index) => {
    const pin = pins[index]
    const started = briefOrder(latest?.originalOrder), restored = briefOrder(latest?.restoredOrder)
    if (latest?.status !== 'failed' || latest.marker !== '42606137512-1'
      || latest.expectedSha !== 'a2198c8c2f608f7b8169329b9da853067618dba6'
      || serialized(latest.selectedHarnesses) !== serialized([pin.harness])
      || latest.startedAt !== pin.startedAt || latest.completedAt !== pin.completedAt
      || !started || !restored || started.entries.length !== 8 || restored.entries.length !== 8
      || started.location !== 'cloud' || started.preferredHarness !== 'claude_code' || started.autoModelRouting !== true
      || started.customized !== pin.originalCustomized || restored.customized !== true
      || createHash('sha256').update(serialized(latest.originalOrder)).digest('hex') !== pin.originalHash
      || createHash('sha256').update(serialized(latest.restoredOrder)).digest('hex') !== restoredHash
      || !Array.isArray(latest.cleanup) || !latest.cleanup.some((entry: any) =>
        entry?.kind === 'effective_model_order_restored' && entry.customizedFlagPreserved === pin.flagPreserved)) return refuse()
    const plan = receiptModelOrderCleanupPlan(initial, latest, now, 'failed')
    if (effectiveOrder(plan.materialized) !== effectiveOrder(plan.currentDefault)) return refuse()
    return plan
  })
  if (Date.parse(failures[0].completedAt) >= Date.parse(failures[1].startedAt)
    || !sameModelOrder(failures[0].restoredOrder, failures[1].originalOrder)) return refuse()
  return { ...plans[1], latest: failures[1] }
}
