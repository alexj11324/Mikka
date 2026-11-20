import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { hasGitHubOrigin } from './cloudflare-source.mjs'
import { childEnvironment, sourceContext, validateReceipt } from './cloudflare-ci.mjs'

const publicSha = 'a'.repeat(40)
const privateSha = 'b'.repeat(40)
const githubApiEnvironment = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_REPOSITORY_ID: '1427517699',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: publicSha,
  GITHUB_WORKFLOW_SHA: publicSha, GITHUB_WORKFLOW_REF: 'alexj11324/Mikka/.github/workflows/cloudflare-api-image.yml@refs/heads/main',
  GITHUB_RUN_ID: '90001', GITHUB_RUN_ATTEMPT: '2', GITHUB_ACTOR: 'alexj11324', GITHUB_ACTOR_ID: '183887963',
  GITHUB_TRIGGERING_ACTOR: 'alexj11324', OVERLAY_SHA: privateSha }
const env = githubApiEnvironment
const context = sourceContext(env, publicSha, privateSha)
const receipt = { version: 1, context, provider: context.provider, publicSha, privateSha, target: 'native-api', publication: 'none',
  overlayCheckout: { repository: 'alexj11324/mikka-hosted-ui', requestedSha: privateSha, actualSha: privateSha },
  stages: ['public-install', 'private-install', 'script-tests'].map(name => ({ name, exit: 0 })) }

test('the native build belongs to the public checkout and pins the private overlay', () => {
  assert.equal(context.publicSha, publicSha)
  assert.equal(context.privateSha, privateSha)
  assert.throws(() => sourceContext({ ...env, GITHUB_SHA: privateSha }, publicSha, privateSha), /CI_PUBLIC_SOURCE_MISMATCH/)
  assert.throws(() => sourceContext({ ...env, OVERLAY_SHA: publicSha }, publicSha, privateSha), /CI_OVERLAY_SOURCE_MISMATCH/)
  assert.throws(() => sourceContext({ ...env, GITHUB_ACTIONS: undefined }, publicSha, privateSha), /CI_PUBLIC_GITHUB_CONTEXT_REQUIRED/)
})

test('a receipt binds both checked-out sources, build and completed stages', () => {
  assert.equal(validateReceipt(receipt, context), receipt)
  assert.throws(() => validateReceipt({ ...receipt, overlayCheckout: { ...receipt.overlayCheckout, actualSha: publicSha } }, context), /CI_OVERLAY_RECEIPT_MISMATCH/)
  assert.throws(() => validateReceipt({ ...receipt, context: { ...context, buildId: 'different' } }, context), /CI_RECEIPT_SOURCE_MISMATCH/)
  assert.throws(() => validateReceipt({ ...receipt, stages: receipt.stages.slice(1) }, context), /CI_RECEIPT_GATE_INCOMPLETE/)
  assert.throws(() => validateReceipt({ ...receipt, target: 'renderers' }, context), /CI_BUILD_TARGET_INVALID/)
})

test('compiler children receive source identities without checkout or publication credentials', () => {
  const child = childEnvironment({ PATH: '/bin', HOSTED_UI_READ_KEY: 'private', CLOUDFLARE_API_TOKEN: 'private', API_PUBLIC_BUILD_SETTINGS: 'private', GITHUB_TOKEN: 'private', CF_RUNTIME_REGISTRY_PASSWORD: 'private', DOCKER_HOST: 'unix:///tmp/docker.sock' }, publicSha, privateSha)
  assert.equal(child.MIKKA_BUILD_REVISION, publicSha)
  assert.equal(child.MIKKA_UI_OVERLAY_SHA, privateSha)
  assert.equal(child.DOCKER_HOST, 'unix:///tmp/docker.sock')
  assert.equal(child.HOSTED_UI_READ_KEY, undefined)
  assert.equal(child.CLOUDFLARE_API_TOKEN, undefined)
  assert.equal(child.API_PUBLIC_BUILD_SETTINGS, undefined)
  assert.equal(child.GITHUB_TOKEN, undefined)
  assert.equal(child.CF_RUNTIME_REGISTRY_PASSWORD, undefined)
  assert.equal(childEnvironment({ DOCKER_HOST: 'tcp://remote:2375' }, publicSha, privateSha).DOCKER_HOST, undefined)
})

test('release compilation occurs once in the public native publisher', async () => {
  const source = await readFile(new URL('./cloudflare-ci.mjs', import.meta.url), 'utf8')
  assert.ok(!source.includes('web-build'))
  assert.ok(!source.includes('desktop-build'))
  assert.ok(!source.includes('WORKERS_CI'))
  assert.ok(!source.includes('.hosted-ui/scripts/*.test.mjs'))
  assert.ok(!source.includes('git@github.com:alexj11324/Mikka.git'))
})


test('GitHub origins normalize authenticated HTTPS and SSH repository names without logging credentials', () => {
  for (const origin of [
    'https://github.com/alexj11324/Mikka.git',
    'https://x-access-token:private-sentinel@github.com/ALEXJ11324/mikka.git',
    'https://private-sentinel@GITHUB.COM/alexj11324/Mikka/',
    'git@github.com:alexj11324/Mikka.git',
    'ssh://git@github.com/alexj11324/mikka.git',
  ]) assert.equal(hasGitHubOrigin(origin, 'alexj11324/Mikka'), true)
  const output = []
  const original = console.error
  console.error = value => output.push(value)
  try {
    for (const origin of [
      'https://private-sentinel@github.com/other/Mikka.git',
      'https://private-sentinel@github.com.example/alexj11324/Mikka.git',
      'http://github.com/alexj11324/Mikka.git',
      'https://github.com:8443/alexj11324/Mikka.git',
      'file:///private-sentinel/alexj11324/Mikka',
      'private-sentinel',
    ]) assert.equal(hasGitHubOrigin(origin, 'alexj11324/Mikka'), false)
  } finally {
    console.error = original
  }
  assert.equal(output.length, 6)
  assert.ok(output.every(line => !line.includes('private-sentinel')))
})


test('API publication rejects a foreign workflow, actor, source or manual run identity', () => {
  for (const patch of [
    { GITHUB_REPOSITORY: 'alexj11324/mikka-hosted-ui' }, { GITHUB_REPOSITORY_ID: '1' },
    { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_WORKFLOW_SHA: privateSha }, { GITHUB_WORKFLOW_REF: 'alexj11324/Mikka/.github/workflows/another.yml@refs/heads/main' },
    { GITHUB_ACTOR_ID: '1' }, { GITHUB_TRIGGERING_ACTOR: 'another' }, { GITHUB_ACTOR: 'another' },
    { GITHUB_RUN_ID: 'not-a-run' }, { GITHUB_RUN_ATTEMPT: '0' },
  ]) assert.throws(() => sourceContext({ ...env, ...patch }, publicSha, privateSha))
  assert.equal(context.buildId, '90001-2')
  assert.equal(context.provider, 'github-actions')
  assert.equal(context.workflowSha, publicSha)
})

test('API workflow keeps source qualification unprivileged and publication on the standard protected main runner', async () => {
  const workflow = await readFile(new URL('../.github/workflows/cloudflare-api-image.yml', import.meta.url), 'utf8')
  const jobs = [...workflow.slice(workflow.indexOf('\njobs:')).matchAll(/^  ([a-z][a-z-]+):\n([\s\S]*?)(?=^  [a-z][a-z-]+:\n|$(?![\s\S]))/gm)]
  assert.deepEqual(jobs.map(job => job[1]), ['source', 'publish', 'service-plan', 'service-build', 'litellm-qualification', 'release-manifest'])
  const sections = Object.fromEntries(jobs.map(job => [job[1], job[2]]))
  const { source, publish } = sections
  for (const [name, text] of Object.entries(sections)) assert.equal((text.match(/runs-on: ubuntu-latest/g) ?? []).length, 1, name)
  assert.ok(source.includes("if: github.event_name == 'pull_request' || github.event_name == 'push'"))
  assert.ok(!source.includes('secrets.'))
  assert.ok(!source.includes('id-token: write'))
  assert.ok(!source.includes('environment:'))
  assert.ok(!source.includes('cloudflare-native-oci.mjs prepare'))
  assert.ok(!workflow.includes('self-hosted'))
  assert.ok(!workflow.includes('pull_request_target'))
  const triggers = workflow.slice(0, workflow.indexOf('\npermissions:'))
  assert.ok(triggers.includes('  push:\n    branches: [main]'))
  assert.ok(triggers.includes('  pull_request:\n    branches: [main]'))
  assert.ok(!triggers.includes('paths:'))
  assert.ok(publish.includes("github.event_name == 'workflow_dispatch'"))
  assert.ok(publish.includes("github.ref == 'refs/heads/main'"))
  assert.ok(publish.includes("github.actor_id == '183887963'"))
  assert.ok(publish.includes('environment: cloudflare-runtime-release'))
  assert.ok(publish.includes('API_PUBLIC_BUILD_SETTINGS: ${{ secrets.API_PUBLIC_BUILD_SETTINGS }}'))
  assert.ok(!publish.includes('secrets.NEXT_PUBLIC_'))
  assert.ok(publish.includes('CF_RUNTIME_REGISTRY_USERNAME: ${{ steps.registry.outputs.username }}'))
  assert.ok(publish.includes('uses: ./.github/actions/cloudflare-registry-credentials'))
  assert.ok(!publish.includes('secrets.CF_RUNTIME_REGISTRY_PASSWORD'))
  assert.ok(!publish.includes('secrets.CF_RUNTIME_REGISTRY_USERNAME'))
  assert.ok(publish.includes('name: api-image-receipt-${{ github.run_id }}-${{ github.run_attempt }}'))
  assert.ok(publish.includes('path: .cloudflare-ci/api-image-receipt.json'))
  assert.ok(publish.includes('include-hidden-files: true'))
  assert.ok(!workflow.includes('WORKERS_CI'))
  const plan = sections['service-plan']
  for (const condition of ["github.repository_id == '1427517699'", "github.actor_id == '183887963'",
    "github.triggering_actor == 'alexj11324'", "github.event_name == 'push'", "github.ref == 'refs/heads/main'"])
    assert.ok(plan.split('\n').find(line => line.trim().startsWith('if:')).includes(condition), condition)
  assert.ok(!plan.includes("github.event_name == 'pull_request'"), 'the protected environment rejects every PR ref, including the owner\'s')
  assert.ok(plan.includes('needs: source'))
  assert.ok(plan.includes('environment: cloudflare-runtime-release'))
  assert.ok(plan.includes('permission-contents: read'))
  assert.ok(plan.includes('persist-credentials: false'))
  assert.ok(!plan.includes('HOSTED_UI_READ_KEY'))
  const build = sections['service-build']
  assert.ok(build.includes('needs: service-plan'))
  assert.ok(build.includes("if: needs.service-plan.outputs.changed == 'true'"))
  assert.ok(build.includes("(matrix.service == 'api' || matrix.service == 'web') && secrets.HOSTED_UI_READ_KEY || ''"))
  assert.ok(build.includes('environment: cloudflare-runtime-release'))
  for (const step of ['Build and verify service', 'Publish immutable service image', 'Upload service artifact', 'Upload service cache receipt']) assert.ok(build.includes('name: ' + step), step)
  const qualification = sections['litellm-qualification']
  assert.ok(qualification.includes('needs: service-plan'))
  assert.ok(qualification.includes("if: needs.service-plan.outputs.litellm_reused == 'true'"))
  assert.ok(qualification.includes('mode: read'))
  assert.ok(!qualification.includes('secrets.'))
  assert.ok(qualification.includes('name: Prove both CLI protocols through the cached proxy'))
  const manifest = sections['release-manifest']
  assert.ok(manifest.includes('needs: [service-plan, service-build, litellm-qualification]'))
  assert.ok(manifest.includes("needs.service-plan.result == 'success'"))
  assert.ok(manifest.includes("needs.service-build.result == 'success' || needs.service-plan.outputs.changed == 'false'"))
  assert.ok(manifest.includes("needs.litellm-qualification.result == 'success' || needs.service-plan.outputs.litellm_reused == 'false'"))
  assert.ok(manifest.includes('name: Upload release manifest'))
  assert.ok(!manifest.includes('secrets.'))
  assert.ok(!manifest.includes('id-token: write'))
})

test('the unified service producer retains the existing image qualification gates', async () => {
  const build = await readFile(new URL('./release/service-build-ci.mjs', import.meta.url), 'utf8')
  for (const gate of ["run('node', ['--test', ...tests], 'TASK_TESTS')",
    "run('python3', ['cloudflare/task-sandbox/native-history.test.py'], 'TASK_HISTORY')",
    "run('bash', ['scripts/release/verify-task-image.sh', tag], 'TASK_VERIFY')",
    "run('bash', ['scripts/build-cloudflare-eve-image.sh', '--independent'], 'EVE_OFFLINE_COMPILE')"]) assert.ok(build.includes(gate), gate)
  for (const script of ['deploy/litellm/offline-check.sh', 'deploy/litellm/conversion-check.sh']) assert.equal(build.split(script).length - 1, 2, 'new and cached images both qualify: ' + script)
  const task = await readFile(new URL('./release/verify-task-image.sh', import.meta.url), 'utf8')
  for (const gate of ['--network none --cap-drop ALL --security-opt=no-new-privileges', '--user 1000:1000',
    'claude --version', 'codex --version', '--cap-add NET_ADMIN', 'review-guest-image.test.py',
    'guard.py prepare-cloudflare', 'guard.py verify', '0:1000:660', 'aiohttp.__version__']) assert.ok(task.includes(gate), gate)
  const conversion = await readFile(new URL('../deploy/litellm/conversion-check.sh', import.meta.url), 'utf8')
  assert.ok(conversion.includes("grep -qx '# pass 7'"))
  assert.ok(conversion.includes("grep -qx '# skipped 0'"))
  for (const name of ['cloudflare-eve-image.yml', 'cloudflare-task-sandbox.yml', 'cloudflare-litellm-image.yml']) {
    const workflow = await readFile(new URL('../.github/workflows/' + name, import.meta.url), 'utf8')
    const automatic = workflow.slice(workflow.indexOf('\njobs:'), workflow.indexOf('  publish:'))
    assert.ok(automatic.includes("if: github.event_name == 'pull_request'"), 'every PR keeps its original qualification: ' + name)
    for (const authority of ['secrets.', 'id-token: write', 'environment: cloudflare-runtime-release']) assert.ok(!automatic.includes(authority), name + ' must remain credential-free')
    assert.ok(workflow.includes('  workflow_dispatch:'))
    assert.ok(!workflow.slice(0, workflow.indexOf('\npermissions:')).includes('  push:'), 'main builds have one producer: ' + name)
  }
})
