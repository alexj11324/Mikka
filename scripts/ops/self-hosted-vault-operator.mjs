// Operator-only adaptation of the exact previous 16/11 driver. The published
// product image, baked worker and provider machine receive no script overlay.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const base = '0b5fbd397dfb56972946fd8f714214ccb26be3c4'
const source = 'c60dd823b39ba51c064e12ecd270c2590c41dbc4'
const prefix = 'ops: inspect private cloud production subscriptions final vault only 88b'
const main = 'scripts/ops/self-hosted-vault-closeout.mjs'
const planPath = 'scripts/ops/self-hosted-vault-plan.json'
const operatorPath = 'scripts/ops/self-hosted-vault-operator.mjs'
const owned = ['.github/workflows/infisical-cloud-capabilities.yml', operatorPath, planPath]
const originalImport = "import { workflowGuard } from './self-hosted-closeout.mjs'"
const adaptedImport = "import { workflowGuard } from './root-vault-workflow-guard.mjs'"
const check = (ok, code) => { if (!ok) throw new Error('VAULT_OPERATOR_' + code) }
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim()
const sha = value => createHash('sha256').update(value).digest('hex')
const driver = env => join(env.RUNNER_TEMP, 'mikka-vault-driver')

function carrier(env) {
  check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_ACTOR === 'alexj11324'
    && env.GITHUB_RUN_ATTEMPT === '1' && env.GITHUB_REPOSITORY === 'alexj11324/Mikka'
    && env.GITHUB_REPOSITORY_ID === '1427517699' && env.GITHUB_REPOSITORY_OWNER_ID === '183887963'
    && env.GITHUB_REF === 'refs/heads/ops/infisical-cloud-capabilities', 'SUBJECT')
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
  check(!event.deleted && !event.forced && event.repository?.id === 1427517699 && event.repository.fork === false
    && event.repository.owner?.id === 183887963 && event.after === env.GITHUB_SHA
    && event.head_commit?.message?.startsWith(prefix), 'EVENT')
  check(/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '') && /^[0-9]+$/.test(env.GITHUB_RUN_ID ?? ''), 'RUN')
  const root = env.GITHUB_WORKSPACE
  check(git(root, 'rev-parse', 'HEAD') === env.GITHUB_SHA && git(root, 'rev-parse', 'HEAD^') === base, 'SOURCE')
  check(git(root, 'diff', '--name-only', 'HEAD^', 'HEAD').split('\n').sort().join('\n') === [...owned].sort().join('\n'), 'PATHS')
  const rawPlan = readFileSync(join(root, planPath))
  const plan = JSON.parse(rawPlan)
  check(plan.repository === env.GITHUB_REPOSITORY && plan.branch === 'ops/infisical-cloud-capabilities'
    && plan.driverSource === source && plan.source === '88b144d52d091d7ff566c63fce6e902e33edc59e'
    && plan.ciRun === 42569765699 && plan.imageRun === 42569765628 && plan.template === 'desktop'
    && plan.imageDigest === 'sha256:96de4972ea7820dca9d7f03d116f8a4589c662ee6a6db9cb33cf8ad0f89ec98e'
    && plan.configDigest === 'sha256:1fb3725678739bf9d448be52ca5ba576ed3e7902b4c9e1240bd5c174f13754b4'
    && plan.workerHash === '6ada1d4f809eace6ca84ad0329562f4aacb78452', 'PLAN')
  check(readFileSync(join(root, planPath)).equals(Buffer.from(git(root, 'show', 'HEAD:' + planPath) + '\n')), 'PLAN_BYTES')
  return { root, rawPlan, plan }
}

function originalFiles(env) {
  const directory = driver(env)
  check(git(directory, 'rev-parse', 'HEAD') === source, 'FROZEN_DRIVER')
  const original = execFileSync('git', ['-C', directory, 'show', source + ':' + main], { stdio: ['ignore','pipe','pipe'] })
  check(original.toString().split(originalImport).length === 2, 'IMPORT_CONTRACT')
  return { directory, original, adapted: Buffer.from(original.toString().replace(originalImport, adaptedImport)) }
}

export function workflowGuard(env) {
  const { root, rawPlan } = carrier(env), { directory, adapted } = originalFiles(env)
  check(readFileSync(join(directory, main)).equals(adapted), 'DRIVER_ONLY_IMPORT_CHANGED')
  for (const path of ['scripts/ops/self-hosted-vault-viewer.mjs','scripts/ops/self-hosted-vault-closeout.test.mjs',
    'scripts/ops/self-hosted-vault-viewer.test.mjs','lib/desktop-rpc/wire.ts']) {
    const original = execFileSync('git', ['-C', directory, 'show', source + ':' + path], { stdio: ['ignore','pipe','pipe'] })
    check(readFileSync(join(directory, path)).equals(original), 'FROZEN_BUSINESS_FILES')
  }
  check(readFileSync(join(directory, planPath)).equals(rawPlan), 'FINAL_PLAN_BYTES')
  check(readFileSync(join(directory, 'scripts/ops/root-vault-workflow-guard.mjs')).equals(readFileSync(join(root, operatorPath))), 'OPERATOR_BYTES')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const env = process.env, mode = process.argv[2], c = carrier(env)
    check(['--preflight','--prepare','--verify'].includes(mode), 'MODE')
    if (mode === '--prepare') {
      const f = originalFiles(env)
      check(readFileSync(join(f.directory, main)).equals(f.original), 'UNMODIFIED_DRIVER_REQUIRED')
      writeFileSync(join(f.directory, main), f.adapted)
      copyFileSync(join(c.root, planPath), join(f.directory, planPath))
      copyFileSync(join(c.root, operatorPath), join(f.directory, 'scripts/ops/root-vault-workflow-guard.mjs'))
      workflowGuard(env)
      console.log(JSON.stringify({ operatorPrepared: true, driverSource: source, originalDriverSha256: sha(f.original),
        finalDriverSha256: sha(f.adapted), onlyDriverImportChanged: true, productImageModified: false, source: c.plan.source }))
    } else {
      if (mode === '--verify') workflowGuard(env)
      console.log(JSON.stringify({ sourceGuard: 'passed', mode, head: env.GITHUB_SHA, parent: base, driverSource: source, source: c.plan.source }))
    }
  } catch (error) {
    console.log(JSON.stringify({ status: 'failed', code: /^VAULT_OPERATOR_[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'VAULT_OPERATOR_FAILED' }))
    process.exitCode = 1
  }
}
