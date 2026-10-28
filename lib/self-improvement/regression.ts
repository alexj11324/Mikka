import { digest, ImprovementError } from './contract'

// Inactive, application-owned rehearsal document. This is not a registry entry
// or a statement that past runs used this Skill.
export const SKILL_PATH = 'lib/self-improvement/skills/run-report/SKILL.md'
export const BASELINE = '# Run report\n\nSummarize the work and the observed result.\n'
export const GUIDELINE = 'Report the exact command, exit code, commit SHA and environment; mark missing evidence unknown and never infer success from silence.'
export const BENCHMARK = Object.freeze({ id: 'report-document-contract', version: 1, cases: [
  { id: 'summary', requires: 'Summarize the work' },
  { id: 'command', requires: 'exact command' },
  { id: 'exit', requires: 'exit code' },
  { id: 'version', requires: 'commit SHA' },
  { id: 'environment', requires: 'environment' },
  { id: 'unknown', requires: 'missing evidence unknown' },
  { id: 'silence', requires: 'never infer success from silence' },
] })
export const BENCHMARK_DIGEST = digest(BENCHMARK)

/** Mechanical document identities only. Keywords never establish effectiveness. */
export function compareDocuments(baseline: string, candidate: string) {
  return { kind: 'semantic_skill_comparison' as const, benchmark: BENCHMARK,
    benchmarkDigest: BENCHMARK_DIGEST, baselineDigest: digest(baseline), candidateDigest: digest(candidate),
    status: 'pending' as const, outcome: 'unknown' as const, reason: 'trusted_comparison_required',
    noRegression: null as boolean | null, improved: null as boolean | null,
    independentVerification: false as const, productionEligible: false as const }
}

export function createSkillCandidate() {
  const content = `${BASELINE}\n## Evidence\n\n${GUIDELINE}\n`
  const result = compareDocuments(BASELINE, content)
  return { path: SKILL_PATH, baseline: BASELINE, content, baselineDigest: digest(BASELINE), candidateDigest: digest(content),
    diff: `--- a/${SKILL_PATH}\n+++ b/${SKILL_PATH}\n@@ -1,3 +1,7 @@\n # Run report\n \n Summarize the work and the observed result.\n+\n+## Evidence\n+\n+${GUIDELINE}\n`, result }
}

export type SkillCandidate = Omit<ReturnType<typeof createSkillCandidate>, 'result'>
/** Recompute identities even for historical proposals; never trust stored booleans. */
export function pendingCandidateComparison(candidate: SkillCandidate) {
  if (candidate.path !== SKILL_PATH || candidate.baseline !== BASELINE ||
    candidate.baselineDigest !== digest(candidate.baseline) || candidate.candidateDigest !== digest(candidate.content))
    throw new ImprovementError('sourceMismatch')
  return compareDocuments(candidate.baseline, candidate.content)
}
