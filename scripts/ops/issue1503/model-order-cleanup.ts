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
export function modelOrderCleanupPlan(initial: any, latest: any, now = Date.now()) {
  const original = briefOrder(initial?.originalOrder)
  const started = briefOrder(latest?.originalOrder), materialized = briefOrder(latest?.restoredOrder)
  const validReceipt = (value: any) => value?.issue === 1503 && value.workspaceId === WORKSPACE_ID
    && value.phase === 'delivery' && value.repository === 'alexj11324/Mikka-handoff'
    && Number.isFinite(Date.parse(value.startedAt)) && Number.isFinite(Date.parse(value.completedAt))
    && Date.parse(value.completedAt) >= Date.parse(value.startedAt)
  const refuse = (): never => { throw new Error('issue1503_cleanup_model_order_receipt_mismatch') }
  if (!validReceipt(initial) || initial.marker !== '42278720813-1' || !original || original.customized !== false
    || createHash('sha256').update(serialized(initial.originalOrder)).digest('hex') !== '528cdc4ffd615042e48ab112b9132779f328637e0469364e71f9cbc22a590792'
    || !validReceipt(latest) || latest.status !== 'passed' || Date.parse(latest.startedAt) < Date.parse(initial.completedAt)
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
