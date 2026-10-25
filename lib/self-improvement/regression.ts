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

/** Fixed cases, fixed evaluator, no model, code execution or caller thresholds. */
export function compareDocuments(baseline: string, candidate: string) {
  const cases = BENCHMARK.cases.map(item => ({ id: item.id,
    baseline: baseline.includes(item.requires), candidate: candidate.includes(item.requires) }))
  return { kind: 'synthetic_document_contract' as const, benchmark: BENCHMARK,
    benchmarkDigest: BENCHMARK_DIGEST, baselineDigest: digest(baseline), candidateDigest: digest(candidate), cases,
    noRegression: cases.every(item => !item.baseline || item.candidate),
    improved: cases.some(item => !item.baseline && item.candidate),
    independentVerification: false as const, productionEligible: false as const }
}

export function createSkillCandidate() {
  const content = `${BASELINE}\n## Evidence\n\n${GUIDELINE}\n`
  const result = compareDocuments(BASELINE, content)
  if (!result.noRegression || !result.improved) throw new ImprovementError('configurationDrift')
  return { path: SKILL_PATH, baseline: BASELINE, content, baselineDigest: digest(BASELINE), candidateDigest: digest(content),
    diff: `--- a/${SKILL_PATH}\n+++ b/${SKILL_PATH}\n@@ -1,3 +1,7 @@\n # Run report\n \n Summarize the work and the observed result.\n+\n+## Evidence\n+\n+${GUIDELINE}\n`, result }
}
