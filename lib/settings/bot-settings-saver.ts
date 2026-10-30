import type { ActionResult } from '@/lib/action-result'
import type { WorkspaceBotModel } from '@/lib/db/schema'

/** A change to a bot's own settings: its model and its default repository. */
export type BotSettingsChange = { model?: WorkspaceBotModel | null; repository?: string | null }
type Field = keyof BotSettingsChange

/**
 * Optimistic saves of a bot's own settings that may overlap (from PR #442's bot-defaults saver).
 * Every save takes a new request seq and becomes the latest request for each
 * field it writes. Only the latest request of a field may commit or roll it
 * back; a rollback restores the last value the server confirmed (seqs are
 * compared, never values, so Codex → Mikka → Codex cannot be confused).
 * If the latest request fails while older requests of that field are still in
 * flight, the rollback waits until all of them have settled and then restores
 * lastConfirmed, which by then includes any older success that came back late.
 * The bot's settings carry no version: only its owner writes them, and the
 * server checks ownership, 可用模型 and installed repositories on every save.
 */
export function createBotSettingsSaver(options: {
  update: (change: BotSettingsChange) => Promise<ActionResult<Required<BotSettingsChange>>>
  apply: (patch: BotSettingsChange) => void
  onSaved: () => void
  /** `error` is the failed latest request's code (botModelNotAllowed…), for the message. */
  onFailed: (change: BotSettingsChange, error: string) => void
  /** False once the owner unmounted: late answers then touch no state and report nothing. */
  isActive?: () => boolean
}) {
  let seq = 0
  const latest: Partial<Record<Field, number>> = {}
  const confirmed: BotSettingsChange = {}
  const confirmedSeq: Partial<Record<Field, number>> = {}
  const inflight: Partial<Record<Field, number>> = {}
  // The latest request of a field failed; its rollback waits for the field's in-flight requests.
  const failedLatest: Partial<Record<Field, { id: number; value: unknown; error: string }>> = {}
  const pick = (source: BotSettingsChange, keys: Field[]) => Object.fromEntries(keys.map(key => [key, source[key]])) as BotSettingsChange

  return {
    /** Server values from a fresh load. */
    confirm(values: Required<BotSettingsChange>) {
      for (const key of Object.keys(values) as Field[]) { Object.assign(confirmed, { [key]: values[key] }); confirmedSeq[key] = seq }
    },
    async save(change: BotSettingsChange) {
      const id = ++seq
      const keys = Object.keys(change) as Field[]
      for (const key of keys) { latest[key] = id; inflight[key] = (inflight[key] ?? 0) + 1; delete failedLatest[key] }
      options.apply(change)
      // A rejected request is a failed one; inflight must drop either way or a later rollback never fires.
      let result: Awaited<ReturnType<typeof options.update>>
      try { result = await options.update(change) } catch { result = { error: 'generic' } } finally { for (const key of keys) inflight[key]! -= 1 }
      if (options.isActive && !options.isActive()) return
      if (!result.error) {
        // Any success is server truth for its fields unless a later request already confirmed them.
        for (const key of keys) if ((confirmedSeq[key] ?? -1) < id) { Object.assign(confirmed, { [key]: result[key] }); confirmedSeq[key] = id }
      }
      const mine = keys.filter(key => latest[key] === id)
      if (result.error) for (const key of mine) failedLatest[key] = { id, value: change[key], error: result.error }
      else if (mine.length) { options.apply(pick(result, mine)); options.onSaved() }
      const rollback = keys.filter(key => failedLatest[key] && failedLatest[key]!.id === latest[key] && inflight[key] === 0)
      if (rollback.length === 0) return
      const failed = Object.fromEntries(rollback.map(key => [key, failedLatest[key]!.value])) as BotSettingsChange
    const error = failedLatest[rollback[0]!]!.error
      for (const key of rollback) delete failedLatest[key]
      options.apply(pick(confirmed, rollback))
      options.onFailed(failed, error)
    },
  }
}
