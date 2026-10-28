import type { RunPolicy, PermissionDecision } from '@mikka/protocol/agent-policy'
import { classifyCommand, decide, runPolicy } from '../permissions'
import type { ToolApprovalRequest } from './tool-approval'

/** Only recognized, unambiguous single commands may inherit an allow.
 * Ambiguity never becomes authorization; the sandbox remains authoritative. */
export function toolApprovalDecision(request: Readonly<ToolApprovalRequest>, sent?: RunPolicy): PermissionDecision {
  const policy = runPolicy(sent)
  if (policy.readOnly && (['item/commandExecution/requestApproval','item/fileChange/requestApproval','Bash','Write','Edit','MultiEdit','NotebookEdit'].includes(request.method))) return 'deny'
  const input = request.input && typeof request.input === 'object' ? request.input as Record<string, unknown> : {}
  // Codex 0.163 may ask about terminal input rather than a command. It must
  // never inherit a command's allow even when a command field is present.
  if (request.method === 'item/commandExecution/requestApproval' && input.kind != null && input.kind !== 'command') return 'ask'
  const command = request.method === 'Bash' || request.method === 'item/commandExecution/requestApproval' ? input.command : null
  if (typeof command !== 'string') return 'ask'
  const action = classifyCommand(command)
  if (!action) return 'ask'
  const result = decide(action, { policy })
  if (result !== 'allow') return result
  // Shell substitutions, operators, quoting, environment wrappers, and
  // unknown syntax cannot borrow an allow intended for one action.
  if (!/^(?:npm|pnpm|yarn|bun|pip|pip3|uv|poetry|cargo|go|gem|brew) (?:install|i|add|ci|get)(?: [A-Za-z0-9@/._= -]+)?$/.test(command)) return 'ask'
  return result
}
