export function isIssueTeamAccessAllowed(access: { linked: boolean; allowed: boolean }) {
  return !access.linked || access.allowed
}
