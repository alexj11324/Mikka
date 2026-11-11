import { channel } from 'node:diagnostics_channel'
import { ActionFailureError } from '../action-error'
import { WorkspaceError } from '../workspace-error'
import { withRpcActionLog } from '../request-log'
import type { DesktopActions } from './handler'
import { isBatchReadAction, MAX_READ_BATCH, type ReadBatchCall, type ReadBatchItem } from './read-batch-contract'
import { withReadBatchContext } from './read-batch-context'

const actionErrors = channel('mikka.request.error')

/** The transport schema validates the whole envelope before invoking this
 * action. Resolve and parse every original action again before executing any
 * item, so batching never skips a reader's argument or ownership checks. */
export function createReadBatch(registry: () => DesktopActions) {
  return async (calls: ReadBatchCall[]): Promise<ReadBatchItem[]> => {
    if (!Array.isArray(calls) || calls.length < 1 || calls.length > MAX_READ_BATCH) throw new TypeError('desktop_rpc_request_invalid')
    const actions = registry()
    const prepared = calls.map(call => {
      if (!call || !isBatchReadAction(call.action) || !Object.hasOwn(actions, call.action)) throw new TypeError('desktop_rpc_request_invalid')
      const action = actions[call.action], args = action.args.safeParse(call.args)
      if (!args.success) throw new TypeError('desktop_rpc_request_invalid', { cause: args.error })
      if (!Array.isArray(args.data)) throw new TypeError('desktop_rpc_request_invalid')
      return { name: call.action, action, args: args.data as never[] }
    })
    return withReadBatchContext(async () => {
      let authFailure: ActionFailureError | undefined
      const items = await Promise.all(prepared.map(({ name, action, args }) => withRpcActionLog<ReadBatchItem>(name, async () => {
        try {
          const result = await action.invoke(args)
          // Cached-list actions preserve expected failures as ActionResult.
          // A revoked identity must still reach Main as the ordinary HTTP 401.
          if (result && typeof result === 'object' && 'error' in result && result.error === 'authRequired') throw new ActionFailureError('authRequired')
          return { ok: true, result }
        } catch (error) {
          try { actionErrors.publish(error) } catch { /* diagnostics cannot change the reader's result */ }
          if (error instanceof ActionFailureError) {
            if (error.code === 'authRequired') authFailure ??= error
            return { ok: false, status: error.code === 'authRequired' ? 401 : 400, error: { code: error.code } }
          }
          if (error instanceof WorkspaceError) return { ok: false, status: 403, error: { code: 'workspaceAccessDenied' } }
          return { ok: false, status: 500, error: { code: 'desktop_rpc_failed' } }
        }
      }, item => item.ok ? 200 : item.status)))
      // All item work and diagnostics settle before the request's identity and
      // batch-only memo are released, including when a reader rejects auth.
      if (authFailure) throw authFailure
      return items
    }, prepared.map(item => item.name))
  }
}
