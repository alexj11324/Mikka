import type { BotModelId, BotsSettingsApi } from './bots-api'

export type BotDefaultsChange = { defaultModel?: BotModelId | null; defaultRepository?: string | null }
type Field = keyof BotDefaultsChange

/**
 * Optimistic saves of the bot defaults that may overlap.
 * Every save takes a new request seq and becomes the latest request for each
 * field it writes. Only the latest request of a field may commit or roll it
 * back; a rollback restores the last value the server confirmed (seqs are
 * compared, never values, so Codex → Mikka → Codex cannot be confused).
 * If the latest request fails while older requests of that field are still in
 * flight, the rollback waits until all of them have settled and then restores
 * lastConfirmed, which by then includes any older success that came back late.
 */
export function createBotDefaultsSaver(options: {
  update: BotsSettingsApi['updateDefaults']
  apply: (patch: BotDefaultsChange) => void
  onSaved: () => void
  onFailed: (change: BotDefaultsChange) => void
}) {
  let seq = 0
  const latest: Partial<Record<Field, number>> = {}
  const confirmed: BotDefaultsChange = {}
  const confirmedSeq: Partial<Record<Field, number>> = {}
  const inflight: Partial<Record<Field, number>> = {}
  // The latest request of a field failed; its rollback waits for the field's in-flight requests.
  const failedLatest: Partial<Record<Field, { id: number; value: unknown }>> = {}
  const pick = (source: BotDefaultsChange, keys: Field[]) => Object.fromEntries(keys.map(key => [key, source[key]])) as BotDefaultsChange

  return {
    /** Server values from a fresh load. */
    confirm(values: Required<BotDefaultsChange>) {
      for (const key of Object.keys(values) as Field[]) { Object.assign(confirmed, { [key]: values[key] }); confirmedSeq[key] = seq }
    },
    async save(change: BotDefaultsChange) {
      const id = ++seq
      const keys = Object.keys(change) as Field[]
      for (const key of keys) { latest[key] = id; inflight[key] = (inflight[key] ?? 0) + 1; delete failedLatest[key] }
      options.apply(change)
      const result = await options.update(change)
      for (const key of keys) inflight[key]! -= 1
      if (!result.error) {
        // Any success is server truth for its fields unless a later request already confirmed them.
        for (const key of keys) if ((confirmedSeq[key] ?? -1) < id) { Object.assign(confirmed, { [key]: result[key] }); confirmedSeq[key] = id }
      }
      const mine = keys.filter(key => latest[key] === id)
      if (result.error) for (const key of mine) failedLatest[key] = { id, value: change[key] }
      else if (mine.length) { options.apply(pick(result, mine)); options.onSaved() }
      const rollback = keys.filter(key => failedLatest[key] && failedLatest[key]!.id === latest[key] && inflight[key] === 0)
      if (rollback.length === 0) return
      const failed = Object.fromEntries(rollback.map(key => [key, failedLatest[key]!.value])) as BotDefaultsChange
      for (const key of rollback) delete failedLatest[key]
      options.apply(pick(confirmed, rollback))
      options.onFailed(failed)
    },
  }
}
