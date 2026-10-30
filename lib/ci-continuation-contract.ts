/** Server-owned continuation receipt; provider text is treated as untrusted data. */
export interface CiContinuation {
  originRunId: string
  originSessionId: string
  issueId: string
  remoteKey: string
  prNumber: number
  scopeVersion: number
  head: string
  fingerprint: string
  followUp: string
  requireSessionResume: true
}
