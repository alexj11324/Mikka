import { deploymentSwitch } from '@/lib/deployment-switches'
/** Task creation and edits ship on (Alex, 2026-10-31: every workspace feature
 * is on by default); deploys migrate `issue_tool_calls` themselves. PostHog's
 * mikka-issue-tools-off is the incident kill switch (lib/deployment-switches.ts). Per-task access and
 * frozen execution grants are still checked by the tools themselves. */
export function issueMutationsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return deploymentSwitch('issueTools', env)
}
