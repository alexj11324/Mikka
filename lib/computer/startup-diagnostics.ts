import { z } from 'zod'

const diagnosticWindow = z.object({
  version: z.literal(1), requesterId: z.string().min(1).max(128), workspaceId: z.uuid(), botId: z.uuid(),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(300).transform(value => value.toLowerCase()),
  expiresAt: z.iso.datetime(),
}).strict()

type Scope = {
  deviceKind: string
  repository: string | null
  harness: string
  subscriptionBindingId?: string
  run: { userId: string; botId: string | null; agentDefinition: {
    readOnly?: boolean
    subscription?: { bindingId: string }
    executionIdentity?: { requester: string; workspaceId: string | null; botId: string | null }
  } | null }
}

/** Operator-owned, at most 24-hour diagnostics for one dedicated Bot/repository.
 * The early bootstrap may use this pure predicate only to propose observation.
 * The final claim response rechecks the same scope before authorizing collection.
 * This adds no authority, database work or persisted assignment flag. Ordinary
 * user-configured task variables remain unchanged, including explicit opt-ins. */
export function cloudStartupDiagnosticCandidate(scope: Scope,
  env: Record<string, string | undefined> = process.env, now = Date.now()): boolean {
  const raw = env.MIKKA_CLOUD_DIAGNOSTIC_WINDOW
  if (!raw || raw.length > 4096) return false
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return false }
  const selected = diagnosticWindow.safeParse(parsed)
  if (!selected.success) return false
  const window = selected.data, expiresAt = Date.parse(window.expiresAt), definition = scope.run.agentDefinition
  const identity = definition?.executionIdentity
  if (expiresAt <= now || expiresAt - now > 24 * 60 * 60_000 || scope.deviceKind !== 'cloud' ||
    !['claude_code', 'codex'].includes(scope.harness) || definition?.readOnly !== true ||
    !scope.subscriptionBindingId || definition.subscription?.bindingId !== scope.subscriptionBindingId ||
    scope.run.userId !== window.requesterId || identity?.requester !== window.requesterId ||
    identity.workspaceId !== window.workspaceId || scope.run.botId !== window.botId || identity.botId !== window.botId ||
    scope.repository !== window.repository) return false
  return true
}

/** The candidate predicate does not grant diagnostics; publication remains
 * inside the existing final fresh claim fence. */
export function cloudStartupDiagnosticEnv(taskEnv: Record<string, string>, scope: Scope,
  env: Record<string, string | undefined> = process.env, now = Date.now()): Record<string, string> {
  return cloudStartupDiagnosticCandidate(scope, env, now) ? { ...taskEnv, CLOUD_STARTUP_TIMING: '1' } : taskEnv
}
