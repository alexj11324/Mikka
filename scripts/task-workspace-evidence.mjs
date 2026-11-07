/** A legacy scope label and the creator alone are deliberately not evidence. */
export function resolveTaskWorkspace(evidence, existingWorkspaces) {
  if (evidence.some(item => item.verified === false || typeof item.workspaceId !== 'string' || !item.workspaceId)) return { workspaceId: null, reason: 'conflicting_evidence' }
  const candidates = [...new Set(evidence.map(item => item.workspaceId?.toLowerCase()).filter(Boolean))]
  if (!candidates.length) return { workspaceId: null, reason: 'missing_evidence' }
  if (candidates.length !== 1) return { workspaceId: null, reason: 'conflicting_evidence' }
  if (!existingWorkspaces.has(candidates[0])) return { workspaceId: null, reason: 'missing_workspace' }
  return { workspaceId: candidates[0], reason: null }
}
