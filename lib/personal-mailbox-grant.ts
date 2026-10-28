import type { Pool } from 'pg'
import type { MailboxToolName } from '@mikka/protocol/mailbox'
import { digest, parseDefinition, type DefinitionSnapshot } from './agent-kit/definition'
import type { WorkerDefinitionSnapshot } from './agent-kit/worker'
import { snapshotMailboxTools, personalWorkerMailboxTools } from './personal-mailbox-capability'
import { MailboxError } from './mailbox-error'

/** Existing authenticated definition-save/approve writes are the grant source.
 * The current head can revoke; a later head cannot expand a frozen catalogue.
 * Effectful callers pass their SAME transaction client with lock=true. */
export async function mailboxGrantTools(q: Pick<Pool, 'query'>, identity: {
  userId: string; botId: string | null; workspaceId: string; executionId: string;
  worker?: WorkerDefinitionSnapshot
}, lock = false): Promise<MailboxToolName[]> {
  let key = identity.botId ?? 'coordinator'
  if (identity.worker) {
    // The built-in Coordinator can explicitly dispatch an owned Bot's cloud
    // run. Resolve its parent scope from the stored execution, not the model
    // or the target Bot. A named Bot can only delegate to its own namespace.
    const { rows: [origin] } = await q.query('select bot_key from agent_kit_executions where owner_id=$1 and id=$2', [identity.userId, identity.executionId])
    if (!origin || (origin.bot_key !== 'coordinator' && origin.bot_key !== identity.botId)) throw new MailboxError('Mailbox parent scope mismatch', 403)
    key = origin.bot_key
  }
  const args = [identity.userId, key]
  const { rows: [head] } = await q.query(`select active_version,workspace_id from agent_kit_heads where owner_id=$1 and bot_key=$2${lock ? ' for share' : ''}`, args)
  if (!head || head.workspace_id !== (key === 'coordinator' ? null : identity.workspaceId)) throw new MailboxError('Mailbox definition scope unavailable', 403)
  const { rows: [execution] } = await q.query(`select snapshot,status,version_id from agent_kit_executions where owner_id=$1 and bot_key=$2 and id=$3${lock ? ' for share' : ''}`, [...args, identity.executionId])
  const snapshot = execution?.snapshot as DefinitionSnapshot | undefined
  if (!snapshot || execution.version_id !== snapshot.revisionId || digest(snapshot.definition) !== snapshot.definitionDigest
    || (!identity.worker && execution.status !== 'running')) throw new MailboxError('Mailbox execution unavailable', 403)
  const { rows: [version] } = await q.query('select definition,digest from agent_kit_versions where owner_id=$1 and bot_key=$2 and id=$3', [...args, head.active_version])
  if (!version || digest(version.definition) !== version.digest) throw new MailboxError('Mailbox grant unavailable', 403)
  const current = parseDefinition(version.definition)
  let frozen = snapshotMailboxTools(snapshot)
  if (identity.worker) {
    const worker = identity.worker, parent = worker.parent
    if (!parent || parent.executionId !== identity.executionId || parent.revisionId !== snapshot.revisionId
      || parent.revision !== snapshot.revision || parent.definitionDigest !== snapshot.definitionDigest) throw new MailboxError('Mailbox parent scope mismatch', 403)
    frozen = personalWorkerMailboxTools(worker.harness, worker).filter(name => frozen.includes(name))
  }
  return frozen.filter(name => current.tools.includes(name))
}
