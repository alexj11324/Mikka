/** Pure issue association proposal. Caller must authorize and validate evidence,
 * then enforce uniqueness/replay atomically in the existing store. No I/O and no
 * recovery/close action: a matching fingerprint never proves recovery. */
export interface MonitorIncidentIdentity {
  userId: string;
  workspaceKey: string;
  checkKey: string;
  fingerprint: string;
}
export interface MonitorIncidentLink extends MonitorIncidentIdentity {
  issueId: string;
  incidentId: string;
}
export function planMonitorIssueAssociation(
  identity: MonitorIncidentIdentity,
  links: readonly MonitorIncidentLink[],
  originalIssue: { userId: string; workspaceKey: string; issueId: string } | null,
): { action: "blocked"; reason: string } | { action: "append"; issueId: string; incidentId: string } | { action: "associate"; issueId: string } | { action: "propose-new" } {
  if (Object.values(identity).some(value => !value.trim()))
    return { action: "blocked", reason: "missing-identity" };
  const matches = links.filter(link => link.userId === identity.userId && link.workspaceKey === identity.workspaceKey && link.checkKey === identity.checkKey && link.fingerprint === identity.fingerprint);
  const unique = new Map(matches.map(link => [JSON.stringify([link.issueId, link.incidentId]), link]));
  if (unique.size > 1) return { action: "blocked", reason: "ambiguous-incident" };
  const match = unique.values().next().value;
  if (match) return match.issueId && match.incidentId ? { action: "append", issueId: match.issueId, incidentId: match.incidentId } : { action: "blocked", reason: "missing-link" };
  if (originalIssue) {
    if (originalIssue.userId !== identity.userId || originalIssue.workspaceKey !== identity.workspaceKey || !originalIssue.issueId.trim())
      return { action: "blocked", reason: "original-issue-scope-mismatch" };
    return { action: "associate", issueId: originalIssue.issueId };
  }
  return { action: "propose-new" };
}
