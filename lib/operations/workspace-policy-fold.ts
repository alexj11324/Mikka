import { z } from 'zod'
import { intersectNetworkDomains } from '@mikka/protocol/agent-policy'
import { cliPolicyLayerSchema } from '@/lib/agent-tool-approval/policy-store'

const externalPolicySchema = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.enum(['allow', 'ask', 'deny']))

/**
 * Fold stored external-write layers into the workspace's restrictive values.
 * Only deny/ask are folded: copying an allow would grant it to every Bot in the
 * workspace, while dropping it can only fall back to the Decision API. Browser
 * ask is not an option and is dropped; github_pull_request is retired with its
 * route; git_push ask was normalized to allow elsewhere.
 */
export function foldExternalWritePermissions(sources: readonly unknown[]): Record<string, 'ask' | 'deny'> {
  const folded: Record<string, 'ask' | 'deny'> = {}
  for (const source of sources) {
    const parsed = externalPolicySchema.parse(source ?? {})
    for (const [key, value] of Object.entries(parsed)) {
      if (value === 'allow') continue
      if (key.startsWith('browser_') && value === 'ask') continue
      if (key === 'github_pull_request') continue
      if (key === 'git_push' && value === 'ask') continue
      if (value === 'deny') folded[key] = 'deny'
      else if (folded[key] !== 'deny') folded[key] = 'ask'
    }
  }
  return folded
}

/**
 * Fold stored CLI layers into one restrictive workspace layer. Permissions take
 * the strictest decision, network allow-lists intersect, read_only wins.
 * Workspace defaults are not a source here and are preserved by applyCliFold.
 */
export function foldCliRunPolicy(sources: readonly unknown[]): z.infer<typeof cliPolicyLayerSchema> {
  const permissions: Record<string, 'ask' | 'deny'> = {}
  let networkAllow: string[] | undefined
  let readOnly = false
  for (const source of sources) {
    const layer = cliPolicyLayerSchema.parse(source ?? {})
    for (const [action, decision] of Object.entries(layer.permissions ?? {})) {
      if (decision === 'allow') continue
      if (action === 'git_push' && decision === 'ask') continue
      if (decision === 'deny') permissions[action] = 'deny'
      else if (permissions[action] !== 'deny') permissions[action] = 'ask'
    }
    if (layer.networkAllow !== undefined) networkAllow = networkAllow === undefined ? [...layer.networkAllow] : intersectNetworkDomains(networkAllow, layer.networkAllow)
    if (layer.approvalMode === 'read_only') readOnly = true
  }
  return {
    ...(Object.keys(permissions).length ? { permissions } : {}),
    ...(networkAllow !== undefined ? { networkAllow } : {}),
    ...(readOnly ? { approvalMode: 'read_only' as const } : {}),
  }
}

/** Merge a CLI fold into the workspace's stored layer, keeping its defaults. */
export function applyCliFold(workspacePolicy: unknown, folded: z.infer<typeof cliPolicyLayerSchema>): z.infer<typeof cliPolicyLayerSchema> {
  const current = cliPolicyLayerSchema.parse(workspacePolicy ?? {})
  return {
    ...current,
    ...(folded.permissions ? { permissions: { ...current.permissions, ...folded.permissions } } : {}),
    ...(folded.networkAllow !== undefined ? { networkAllow: folded.networkAllow } : {}),
    ...(folded.approvalMode ? { approvalMode: folded.approvalMode } : {}),
  }
}

/** Merge an external fold over the workspace's current choices. */
export function applyExternalFold(workspacePolicy: unknown, folded: Record<string, 'ask' | 'deny'>): Record<string, 'allow' | 'ask' | 'deny'> {
  const current = externalPolicySchema.parse(workspacePolicy ?? {})
  return { ...current, ...folded }
}
