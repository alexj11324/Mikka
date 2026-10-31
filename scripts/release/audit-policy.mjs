import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const LEVELS = new Set(['info', 'low', 'moderate', 'high', 'critical'])
const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/
function exceptionValid(value, now) {
  if (!value || !packageName.test(value.package ?? '') || typeof value.advisory !== 'string' || !value.advisory ||
      typeof value.version !== 'string' || !value.version || typeof value.owner !== 'string' || !value.owner.trim() ||
      typeof value.reason !== 'string' || value.reason.trim().length < 20) return false
  const reviewed = Date.parse(value.reviewedAt), expires = Date.parse(value.expiresAt)
  return Number.isFinite(reviewed) && Number.isFinite(expires) && reviewed <= now && expires > now &&
    expires > reviewed && expires - reviewed <= 30 * 86_400_000
}

export function assessAudit(report, lock, policy, now = Date.now()) {
  if (policy?.version !== 1 || !Array.isArray(policy.blockSeverities) || policy.blockSeverities.some(x => !LEVELS.has(x)) ||
      !policy.blockSeverities.includes('critical') || !policy.blockSeverities.includes('high') || !Array.isArray(policy.exceptions)) throw Error('releaseAuditPolicyInvalid')
  if (policy.exceptions.some(value => !exceptionValid(value, now))) throw Error('releaseAuditExceptionInvalidOrExpired')
  const counts = report?.metadata?.vulnerabilities
  if (!counts || [...LEVELS].some(level => !Number.isSafeInteger(counts[level]) || counts[level] < 0)) throw Error('releaseAuditReportUnavailable')
  if (report?.advisories && report.metadata?.vulnerabilities) {
    if (report.error || report.code || (Array.isArray(report.muted) ? report.muted.length : Object.keys(report.muted ?? {}).length)) throw Error('releaseAuditReportUnavailable')
    const findings = []
    for (const [advisory, value] of Object.entries(report.advisories)) {
      if (!packageName.test(value.module_name ?? '') || !LEVELS.has(value.severity) || !Array.isArray(value.findings) ||
          !value.findings.length || value.findings.some(finding => typeof finding.version !== 'string' || !finding.version)) throw Error('releaseAuditFindingInvalid')
      if (!policy.blockSeverities.includes(value.severity)) continue
      const versions = [...new Set(value.findings.map(finding => finding.version))]
      const exempt = versions.every(version => policy.exceptions.some(exception => exception.package === value.module_name &&
        exception.version === version && exception.advisory === advisory))
      if (!exempt) findings.push({ package: value.module_name, severity: value.severity, advisories: [advisory], versions })
    }
    for (const severity of policy.blockSeverities) if (report.metadata.vulnerabilities[severity] > 0 &&
      !Object.values(report.advisories).some(value => value.severity === severity)) throw Error('releaseAuditFindingMissing')
    return { allowed: findings.length === 0, findings }
  }
  if (report?.auditReportVersion !== 2 || report.error || !report.vulnerabilities || !report.metadata?.vulnerabilities ||
      !lock?.packages || lock.lockfileVersion < 2) throw Error('releaseAuditReportUnavailable')
  const findings = []
  for (const [name, value] of Object.entries(report.vulnerabilities)) {
    if (!packageName.test(name) || !LEVELS.has(value.severity) || !Array.isArray(value.nodes) || !Array.isArray(value.via)) throw Error('releaseAuditFindingInvalid')
    if (!policy.blockSeverities.includes(value.severity)) continue
    const advisories = value.via.filter(x => x && typeof x === 'object').map(x => String(x.source ?? x.url ?? ''))
    // A transitive advisory without a direct record remains blocked; no inferred exception.
    const versions = value.nodes.map(node => lock.packages[node]?.version)
    if (!versions.length || versions.some(x => typeof x !== 'string' || !x)) throw Error('releaseAuditLockMismatch')
    const exempt = advisories.length > 0 && advisories.every(advisory => versions.every(version =>
      policy.exceptions.some(exception => exception.package === name && exception.version === version && exception.advisory === advisory)))
    if (!exempt) findings.push({ package: name, severity: value.severity, advisories, versions: [...new Set(versions)] })
  }
  return { allowed: findings.length === 0, findings }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [reportFile, policyFile, lockFile] = process.argv.slice(2)
  if (!reportFile || !lockFile || !policyFile) throw Error('releaseAuditInputsRequired')
  const report = JSON.parse(await readFile(reportFile, 'utf8')), policy = JSON.parse(await readFile(policyFile, 'utf8'))
  const lockBytes = await readFile(lockFile), lock = report.advisories ? null : JSON.parse(String(lockBytes))
  const result = assessAudit(report, lock, policy)
  console.log(JSON.stringify({ ...result, lockSha256: createHash('sha256').update(lockBytes).digest('hex') }))
  if (!result.allowed) process.exitCode = 1
}
