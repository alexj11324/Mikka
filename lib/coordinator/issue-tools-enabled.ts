/** Enable only after the target application's durable receipt schema is installed. */
export function issueMutationsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.MIKKA_ISSUE_TOOLS_ENABLED === '1'
}
