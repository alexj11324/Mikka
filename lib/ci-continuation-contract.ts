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

/** A known unsupported original session; safe to expose as a generic reason. */
export class CiContinuationUnsupported extends Error {
  constructor(readonly reason: 'subscription' | 'skill' | 'session_missing' | 'definition_missing' | 'definition_changed' | 'mailbox') { super('CI original-session continuation is not supported') }
}
