import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { compareGroupPolicies, type GroupEvalCase, type GroupEvalObservation } from '../lib/coordinator/group-decision-eval'
import { GROUP_BASELINE_VERSION, GROUP_POLICY_VERSION } from '../lib/coordinator/group-decision-policy'
import { LEGACY_DECISION_MODEL } from '../lib/coordinator/decision'
import { assertFlashTestModel } from './test-model-policy.mjs'

const args = process.argv.slice(2)
const value = (flag: string) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined }
const baselinePath = value('--baseline'), candidatePath = value('--candidate'), output = value('--output')
if (!baselinePath || !candidatePath || !output) throw new Error('Usage: --baseline observations.json --candidate observations.json --output report.json')
const bytes = readFileSync(new URL('../tests/fixtures/group-decision-cases.json', import.meta.url))
const datasetDigest = createHash('sha256').update(bytes).digest('hex')
const dataset = JSON.parse(bytes.toString()) as { version: string; cases: GroupEvalCase[] }
type Evidence = { policyVersion: string; datasetDigest: string; revision: string; evidenceKind: 'synthetic' | 'live' | 'historical'; modelId: string; observations: GroupEvalObservation[] }
const read = (path: string): Evidence => {
  const evidence = JSON.parse(readFileSync(path, 'utf8')) as Evidence
  if (evidence.datasetDigest !== datasetDigest || !['synthetic','live','historical'].includes(evidence.evidenceKind) || !evidence.policyVersion || !/^[a-f0-9]{40}$/.test(evidence.revision) || !Array.isArray(evidence.observations)) throw new Error('Unbound or invalid evaluation evidence')
  if(evidence.evidenceKind==='historical') {
    if(evidence.modelId!==LEGACY_DECISION_MODEL)assertFlashTestModel(evidence.modelId,'group-decision-eval')
  } else assertFlashTestModel(evidence.modelId,'group-decision-eval')
  return evidence
}
const baseline = read(baselinePath), candidate = read(candidatePath)
if (baseline.evidenceKind !== candidate.evidenceKind || baseline.modelId !== candidate.modelId) throw new Error('Compare the same evidence kind and model; do not mix simulated and live results')
if (baseline.policyVersion !== GROUP_BASELINE_VERSION || candidate.policyVersion !== GROUP_POLICY_VERSION) throw new Error('Policy versions must match the reviewed baseline and candidate')
const comparison = compareGroupPolicies(dataset.cases, baseline.observations, candidate.observations)
const report = { dataset: dataset.version, datasetDigest, evidenceKind: candidate.evidenceKind, modelId: candidate.modelId,
  baselinePolicy: baseline.policyVersion, candidatePolicy: candidate.policyVersion, baselineRevision: baseline.revision, candidateRevision: candidate.revision,
  ...comparison, costScope: 'primary-routing-decision-api', productionAccepted: false, policyChanged: false }
writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ output, evidenceKind: report.evidenceKind, reviewReady: report.reviewReady, blocked: report.blocked, productionAccepted: false }))
if (!report.reviewReady) process.exitCode = 1
