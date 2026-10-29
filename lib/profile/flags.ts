// Deployment switches for proactive work (R-73, docs/design/proactive.md § 3).
// Both are off unless set to 1 or true, so a self-hosted Mikka spends nothing
// on it. This is the only place that reads them.

const on = (value: string | undefined) => value === '1' || value?.toLowerCase() === 'true'

/** PROACTIVE_PROFILE_ENABLED: fact extraction and the nightly merge. */
export function profileEnabled(): boolean {
  return on(process.env.PROACTIVE_PROFILE_ENABLED)
}

/** PROACTIVE_RESEARCH_ENABLED: reserved for the nightly research run (phase 2); nothing reads it yet. */
export function researchEnabled(): boolean {
  return on(process.env.PROACTIVE_RESEARCH_ENABLED)
}
