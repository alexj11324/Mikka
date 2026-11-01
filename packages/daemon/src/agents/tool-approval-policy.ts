import { networkDomainSchema, type RunPolicy } from '@mikka/protocol/agent-policy'
import type { ToolApprovalRequest } from './tool-approval'
import { classifyWrite, rawCliShellAvailable } from '../permissions'
import { matchesRunSandboxDomain } from './run-sandbox-launcher'
import { mailboxInputs } from '@mikka/protocol/mailbox'

/** Native CLI callbacks do not attest which Mikka action a shell command
 * performs. Do not infer authority from command text or ask for unrelated
 * approvals. Unsupported callback capabilities remain unavailable. */
export function toolApprovalDecision(request: Readonly<ToolApprovalRequest>, policy?: RunPolicy, worktree?: string, apps: readonly string[] = [], runHosts: readonly string[] = [], mailboxEnabled = false): 'unavailable' | 'allow' | 'ask' | 'deny' {
  // This method is emitted only by the host-owned run proxy. Native CLI
  // callbacks use their own method namespace and cannot select this action.
  if (request.method === 'sandbox/network' && policy) {
    const value = request.input as { host?: unknown; port?: unknown } | null
    if (!value || typeof value.host !== 'string' || /[*/:]/.test(value.host) || !networkDomainSchema.safeParse(value.host).success || !Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535) return 'deny'
    // Under `ask` the repo's own allow list, and the Mikka server endpoints
    // this run was handed (they check the run token), are pre-authorized, as
    // the agent is told; any other destination is still asked. Nobody can
    // answer an ask mid-run, so asking for these stalled every push.
    if (policy.permissions.network === 'ask' && matchesRunSandboxDomain({ host: value.host, port: Number(value.port) }, [...policy.networkAllow, ...runHosts])) return 'allow'
    return policy.permissions.network
  }
  if (request.method.startsWith('cli/') && policy && worktree) {
    const tool = request.method.slice(4)
    // These fixed strict-MCP registrations delegate to the existing scoped
    // server. A transport permit is never approval of a computer action:
    // the run-bound broker still owns allow/ask/deny and current authority.
    if (['get_desktop_state','click','type_text','press_key','scroll','capture_screenshot','start_screen_recording','stop_screen_recording'].some(name => tool === `mcp__mikka_computer__${name}`)) {
      return policy.readOnly || !policy.permissions.computer_use || policy.permissions.computer_use === 'deny' ? 'deny' : 'allow'
    }
    if (['submit','request_help','ask_human','report_blocked','submit_capture'].some(name => tool === `mcp__mikka__${name}`)) return 'allow'
    // Only the host-claimed capability registers these strict in-process MCP
    // tools. Each call still goes through the frozen server tool/scope grant;
    // this transport permit grants no repository or user action authority.
    if (mailboxEnabled && Object.keys(mailboxInputs).some(name => tool === `mcp__mikka_mailbox__${name}`)) return 'allow'
    if (tool === 'Bash' || tool === 'PowerShell') return rawCliShellAvailable(policy) ? 'allow' : 'unavailable'
    // App entries this daemon registered for the run reach only the Mikka
    // server, which owns each call's allow/ask/deny; never a model-named server.
    if (apps.some(name => tool.startsWith(`mcp__${name}__`) && tool.length > `mcp__${name}__`.length)) return 'allow'
    if (tool === 'WebFetch' || tool === 'WebSearch') return policy.permissions.network
    const input = request.input as {file_path?: unknown; notebook_path?: unknown} | null
    if (['Write','Edit','MultiEdit','NotebookEdit'].includes(tool)) {
      if (policy.readOnly) return 'deny'
      const path = tool === 'NotebookEdit' ? input?.notebook_path : input?.file_path
      if (typeof path !== 'string') return 'unavailable'
      // Resolve symlinks against the host-owned worktree. A callback cannot
      // expand the launcher's immutable filesystem ceiling.
      return classifyWrite(worktree,path) === 'write_in_worktree' ? 'allow' : 'unavailable'
    }
  }
  return 'unavailable'
}
