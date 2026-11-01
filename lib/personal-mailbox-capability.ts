import { z } from 'zod'
import { mailboxInputs, type MailboxToolName } from '@mikka/protocol/mailbox'
import { type DefinitionSnapshot } from './agent-kit/definition'
import { workerDefinitionDigest } from './agent-kit/worker-digest'

export const workerMailboxScope = z.strictObject({ botId: z.uuid().nullable(), workspaceId: z.uuid() })
export type WorkerMailboxScope = z.infer<typeof workerMailboxScope>
export interface WorkerMailboxGrant { version: 2; tools: MailboxToolName[]; scope: WorkerMailboxScope }
const MAILBOX_TOOL_NAMES = Object.keys(mailboxInputs) as MailboxToolName[]
export function snapshotMailboxTools(snapshot: DefinitionSnapshot | null | undefined): MailboxToolName[] {
  return MAILBOX_TOOL_NAMES.filter(name => snapshot?.effectiveTools?.includes(name) && snapshot.definition?.tools?.includes(name))
}
/** Reads trusted stored snapshots only. A parsed model body is never a grant. */
export function personalWorkerMailboxTools(harness: string, raw: unknown): MailboxToolName[] {
  if (!['claude_code', 'codex'].includes(harness) || !raw || typeof raw !== 'object') return []
  const s = raw as { schemaVersion?: unknown; kind?: unknown; harness?: unknown; instructions?: unknown; definitionDigest?: unknown; model?: unknown; pinnedDeviceId?: unknown; subscription?: unknown; apiKey?: unknown; readOnly?: unknown; parent?: { executionId?: unknown }; mailbox?: WorkerMailboxGrant }
  const g = s.mailbox
  if (s.schemaVersion !== 1 || s.kind !== 'worker' || s.harness !== harness || typeof s.instructions !== 'string' || typeof s.parent?.executionId !== 'string'
    || g?.version !== 2 || !workerMailboxScope.safeParse(g.scope).success || !Array.isArray(g.tools) || !g.tools.length || new Set(g.tools).size !== g.tools.length
    || g.tools.some(name => !MAILBOX_TOOL_NAMES.includes(name))) return []
  const expected = workerDefinitionDigest({ ...s, harness, instructions: s.instructions, mailbox: g })
  return s.definitionDigest === expected ? [...g.tools] : []
}
export function personalWorkerMailboxSupported(harness: string, raw: unknown): boolean { return personalWorkerMailboxTools(harness, raw).length > 0 }

/** Scope comes from the dispatch host, including an explicit unbound Bot.
 * A deleted/rebound Bot must never turn an existing worker into a personal one. */
export function personalWorkerMailboxScopeMatches(harness: string, raw: unknown, scope: WorkerMailboxScope): boolean {
  if (!personalWorkerMailboxSupported(harness, raw)) return false
  const grant = (raw as { mailbox: WorkerMailboxGrant }).mailbox
  return grant.scope.botId === scope.botId && grant.scope.workspaceId === scope.workspaceId
}
