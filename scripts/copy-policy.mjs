// The cloud machine is 「Mikka Cloud」 in both languages, a brand name that is never
// translated (decisions.md 2026-10-31). 「E2B」 names only the provider: the workspace's
// own E2B API key and E2B's errors and charges.

// A translated brand (「Mikka 云」, 「Mikka 云端」) and the old 「切换到云端」 action.
export const banned = /mikka[\s_-]*云|切换到云端/i
// Dated decision log keeps history as written; the policy test holds the negative examples.
export const allowedPaths = ['docs/design/decisions.md', 'docs/design/decisions', 'scripts/copy-policy.mjs', 'scripts/copy-policy.test.mjs']

export function bannedHits(text) {
  return text.split('\n').flatMap((line, index) => banned.test(line) ? [{ line: index + 1, text: line.trim() }] : [])
}

/** Message keys that name the cloud machine itself; each must say Mikka Cloud and never E2B. */
export const machineNameKeys = ['Computer.cloud', 'Shell.newTaskDialog.cloud', 'AgentCopy.dispatchCloud']

/** Problems with one locale's machine-name strings, given a key → value lookup. */
export function machineNameProblems(lookup) {
  return machineNameKeys.flatMap(key => {
    const value = lookup(key)
    if (typeof value !== 'string') return [`${key}: missing`]
    if (/E2B/i.test(value)) return [`${key}: names the machine E2B — ${value}`]
    if (!value.includes('Mikka Cloud')) return [`${key}: does not say Mikka Cloud — ${value}`]
    return []
  })
}
