import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'
import { after } from 'next/server'

export type IssueEffect = { kind: 'sync' | 'scope'; issueId: string } | { kind: 'wake'; userId: string }
const deferred = new AsyncLocalStorage<IssueEffect[]>()

/** Workflow mutations persist these descriptors in the same commit as the issue. */
export function collectIssueEffects<T>(effects: IssueEffect[], callback: () => T): T {
  return deferred.run(effects, callback)
}

export async function runIssueEffect(effect: IssueEffect) {
  switch (effect.kind) {
    case 'sync': return (await import('@/lib/linear-sync/worker')).processLinearIssueOutbox(effect.issueId)
    case 'scope': return (await import('@/lib/issue-scope-judge')).judgeIssueScope(effect.issueId, 'the Mikka app')
    case 'wake': return (await import('@/lib/coordinator/wake')).wakeCoordinator(effect.userId)
  }
}

export function scheduleIssueEffect(effect: IssueEffect) {
  const effects = deferred.getStore()
  if (effects) {
    if (!effects.some(item => JSON.stringify(item) === JSON.stringify(effect))) effects.push(effect)
    return
  }
  after(async () => {
    try { await runIssueEffect(effect) }
    catch { console.error('Issue background work could not start') }
  })
}
