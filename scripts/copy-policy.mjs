// The cloud machine is 「E2B」 in product copy (Figma, FE-7). The old name must not come back.
// Old cloud name (any case, spacing, 云) and the old 「切换到云端」 action.
export const banned = /mikka[\s_-]*(cloud|云)|切换到云端/i
// Identifiers keep their names: env vars, the analytics flag key, the E2B template name.
export const allowedTokens = [/\bMIKKA_CLOUD_[A-Z0-9_]+\b/g, /\bmikka-cloud-computer\b/g, /\bmikka-cloud-desktop[\w-]*/g]
// Dated decision log keeps history as written; the policy test holds the negative examples.
export const allowedPaths = ['docs/design/decisions.md', 'scripts/copy-policy.mjs', 'scripts/copy-policy.test.mjs']

export function bannedHits(text) {
  return text.split('\n').flatMap((line, index) => {
    const rest = allowedTokens.reduce((value, token) => value.replace(token, ''), line)
    return banned.test(rest) ? [{ line: index + 1, text: line.trim() }] : []
  })
}
