import { mailboxInputs, type MailboxToolName } from '@mikka/protocol/mailbox'
import { digest, type DefinitionSnapshot } from './agent-kit/definition'

export interface WorkerMailboxGrant { version: 1; tools: MailboxToolName[] }
const MAILBOX_TOOL_NAMES = Object.keys(mailboxInputs) as MailboxToolName[]
export function snapshotMailboxTools(snapshot: DefinitionSnapshot | null | undefined): MailboxToolName[] {
  return MAILBOX_TOOL_NAMES.filter(name => snapshot?.effectiveTools?.includes(name) && snapshot.definition?.tools?.includes(name))
}
/** Reads trusted stored snapshots only. A parsed model body is never a grant. */
export function personalWorkerMailboxTools(harness: string, raw: unknown): MailboxToolName[] {
  if (!['claude_code', 'codex'].includes(harness) || !raw || typeof raw !== 'object') return []
  const s = raw as { schemaVersion?: unknown; kind?: unknown; harness?: unknown; instructions?: unknown; definitionDigest?: unknown; subscription?: unknown; parent?: { executionId?: unknown }; mailbox?: WorkerMailboxGrant }
  const g = s.mailbox
  if (s.schemaVersion !== 1 || s.kind !== 'worker' || s.harness !== harness || typeof s.instructions !== 'string' || typeof s.parent?.executionId !== 'string'
    || g?.version !== 1 || !Array.isArray(g.tools) || !g.tools.length || new Set(g.tools).size !== g.tools.length
    || g.tools.some(name => !MAILBOX_TOOL_NAMES.includes(name))) return []
  const expected = digest({ harness, instructions: s.instructions, ...(s.subscription ? { subscription: s.subscription } : {}), mailbox: g })
  return s.definitionDigest === expected ? [...g.tools] : []
}
export function personalWorkerMailboxSupported(harness: string, raw: unknown): boolean { return personalWorkerMailboxTools(harness, raw).length > 0 }
