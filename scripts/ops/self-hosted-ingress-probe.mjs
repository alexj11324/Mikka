/** Existing vault workload only. No alternate identity, main-ref impersonation,
 * product deployment, or execution of a moving probe branch. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { workflowGuard } from './self-hosted-closeout.mjs'

export const PROBE = Object.freeze({
  source: 'c17b55652b65fb3463edf486fc544ba1c2d0e3ef',
  tree: '5e4aac51158eaef9d286157f89ee7b1bf8d5a520',
  files: {
    'scripts/e2b/preview-ingress-probe.py': '53eff11f87b4b6ee0b41619370c0627ace8d782b9e4eb6fe79e553c8f5d6a7f0',
    'scripts/e2b/preview-ingress-acceptance.mjs': '4a30d479ed5c49f761e4af2da24577dcb08dc186579d5b40ce46faf7781ed242',
    'scripts/e2b/preview-ingress-acceptance.test.mjs': '5411669abc3feab294ebaf0a932df9d3185f04f821e87c8cfb8ae6293f96c6d4',
  },
})
const PURPOSE = 'mikka-preview-ingress-spike'
const BRANCH = 'ops/self-hosted-vault-closeout-20261108'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const ID = /^[A-Za-z0-9_-]{1,128}$/
const check = (value, code) => { if (!value) throw new Error(code) }
const git = (directory, ...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', maxBuffer: 4096 }).trim()

export function assertOpsContext(env, event, checkout) {
  workflowGuard(env)
  check(env.GITHUB_ACTIONS === 'true'
    && env.GITHUB_WORKFLOW_REF === `alexj11324/Mikka/.github/workflows/self-hosted-vault-closeout.yml@refs/heads/${BRANCH}`
    && event.repository?.id === 1427517699 && event.repository?.owner?.id === 183887963
    && event.ref === `refs/heads/${BRANCH}` && event.after === env.GITHUB_SHA
    && event.deleted === false && event.forced === false && checkout === env.GITHUB_SHA,
  'ingress_ops_source_refused')
}

export function assertProbeIdentity({ source, tree, dirty, files }) {
  check(source === PROBE.source && tree === PROBE.tree && dirty === false
    && Object.entries(PROBE.files).every(([path, hash]) => files?.[path] === hash), 'ingress_probe_source_refused')
}

async function verifySources(directory, env = process.env) {
  assertOpsContext(env, JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')), git(process.cwd(), 'rev-parse', 'HEAD'))
  const files = Object.fromEntries(await Promise.all(Object.keys(PROBE.files).map(async path =>
    [path, createHash('sha256').update(await readFile(resolve(directory, path))).digest('hex')])))
  assertProbeIdentity({ source: git(directory, 'rev-parse', 'HEAD'), tree: git(directory, 'rev-parse', 'HEAD^{tree}'),
    dirty: git(directory, 'status', '--porcelain', '--untracked-files=no') !== '', files })
}

/** Cleanup alone controls the next allocation. Capability failure stays red but
 * cannot suppress another independently scoped, safely sequenced experiment. */
export function summarizeProbe(template, { journal, report, cleanupReport }) {
  check(['claude', 'codex'].includes(template), 'ingress_probe_template_refused')
  const result = { probeSource: PROBE.source, probeTree: PROBE.tree, requestedTemplate: template,
    scope: 'nft-output-reply-fixture-ports-only', preListenerIsolationProven: false, agentPrivilegeBoundaryProven: false,
    derivedRuntimeAcceptance: false, capabilityPassed: false, cleanupConfirmed: false }
  if (cleanupReport?.version !== 1 || cleanupReport.purpose !== PURPOSE || cleanupReport.sourceCommit !== PROBE.source) return result
  if (!journal) {
    result.cleanupConfirmed = cleanupReport.cleanup?.stopped === true
      && cleanupReport.cleanup.outcome === 'no_creation_requested' && cleanupReport.cleanup.scopeVerified === false
    return result
  }
  if (journal.version !== 1 || journal.purpose !== PURPOSE || journal.sourceCommit !== PROBE.source
    || journal.requestedTemplate !== template || !UUID.test(journal.fixtureId ?? '')
    || journal.sandboxId !== null && !ID.test(journal.sandboxId ?? '')
    || cleanupReport.fixtureId !== journal.fixtureId || cleanupReport.requestedTemplate !== template
    || cleanupReport.sandboxId !== journal.sandboxId) return result
  result.fixtureId = journal.fixtureId
  result.sandboxId = journal.sandboxId
  const cleanup = cleanupReport.cleanup
  result.cleanupConfirmed = cleanup?.stopped === true && (cleanup.outcome === 'provider_already_absent'
    || cleanup.outcome === 'provider_kill_acknowledged' && cleanup.scopeVerified === true)
  if (report?.version === 1 && report.purpose === PURPOSE && report.sourceCommit === PROBE.source
    && report.fixtureId === journal.fixtureId && report.requestedTemplate === template
    && report.sandboxId === journal.sandboxId && ID.test(report.sandboxId ?? '')
    && report.probeSha256 === PROBE.files['scripts/e2b/preview-ingress-probe.py']) {
    result.capabilityPassed = report.passed === true
    result.sudoNonInteractiveRoot = report.user?.sudoNonInteractiveRoot === true
  }
  return result
}

async function readOptionalJson(path) {
  try {
    const info = await lstat(path)
    check(info.isFile() && !info.isSymbolicLink() && info.size <= 65_536, 'ingress_probe_receipt_refused')
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) { if (error?.code === 'ENOENT') return null; throw error }
}

async function main([operation, sourceDirectory, template]) {
  check(['check', 'verdict'].includes(operation) && sourceDirectory && ['claude', 'codex'].includes(template), 'ingress_ops_arguments')
  await verifySources(resolve(sourceDirectory))
  if (operation === 'check') {
    console.log(JSON.stringify({ opsSource: process.env.GITHUB_SHA, probeSource: PROBE.source, probeTree: PROBE.tree, sourceVerified: true }))
    return
  }
  const output = resolve(process.env.RUNNER_TEMP, `preview-ingress-${template}`)
  const [journal, report, cleanupReport] = await Promise.all([
    readOptionalJson(resolve(output, 'report.json.cleanup.json')), readOptionalJson(resolve(output, 'report.json')),
    readOptionalJson(resolve(output, 'cleanup.json')),
  ])
  const verdict = { opsSource: process.env.GITHUB_SHA, ...summarizeProbe(template, { journal, report, cleanupReport }) }
  await mkdir(output, { recursive: true, mode: 0o700 })
  await writeFile(resolve(output, 'verdict.json'), JSON.stringify(verdict, null, 2) + '\n', { mode: 0o600 })
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
    `cleanup_confirmed=${verdict.cleanupConfirmed}\ncapability_passed=${verdict.capabilityPassed}\n`)
  console.log(JSON.stringify(verdict))
  if (!verdict.capabilityPassed || !verdict.cleanupConfirmed) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => { console.error('ingress_ops_refused'); process.exitCode = 1 })
}
