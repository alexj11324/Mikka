import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import assert from 'node:assert/strict'
import test from 'node:test'
import { resolvePinnedPnpm } from './pinned-pnpm.mjs'

const pin = 'pnpm@10.34.3'
function fakeCommands(responses) {
  const calls = []
  return {
    calls,
    execute(file, args, options) {
      calls.push({ file, args, options })
      const response = responses[file]
      if (response instanceof Error) throw response
      assert.equal(typeof response, 'string', `UNEXPECTED_COMMAND_${file}`)
      return response
    },
  }
}

test('the exact native pnpm installed by CI needs no Corepack', () => {
  const fake = fakeCommands({ pnpm: '10.34.3\n' })
  assert.deepEqual(resolvePinnedPnpm({ packageManager: pin, execute: fake.execute }),
    { file: 'pnpm', args: [], version: '10.34.3' })
  assert.deepEqual(fake.calls.map(({ file, args }) => ({ file, args })), [{ file: 'pnpm', args: ['--version'] }])
})

test('an absent native executable falls back to the explicit cached Corepack pin', () => {
  const fake = fakeCommands({ pnpm: Object.assign(new Error('NOT_INSTALLED'), { code: 'ENOENT' }), corepack: '10.34.3\n' })
  assert.deepEqual(resolvePinnedPnpm({ packageManager: pin, execute: fake.execute }),
    { file: 'corepack', args: [pin], version: '10.34.3' })
  assert.deepEqual(fake.calls.map(({ file, args }) => ({ file, args })), [
    { file: 'pnpm', args: ['--version'] }, { file: 'corepack', args: [pin, '--version'] },
  ])
})

test('a native version mismatch does not pass and can use the cached exact pin', () => {
  const fake = fakeCommands({ pnpm: '11.0.0\n', corepack: '10.34.3\n' })
  assert.equal(resolvePinnedPnpm({ packageManager: pin, execute: fake.execute }).file, 'corepack')
  assert.equal(fake.calls.length, 2)
})

test('both candidates must actually report the exact version', () => {
  for (const native of ['11.0.0\n', '10.34.3\n11.0.0\n', '', new Error('NATIVE_FAILED')]) {
    const fake = fakeCommands({ pnpm: native, corepack: '10.34.2\n' })
    assert.throws(() => resolvePinnedPnpm({ packageManager: pin, execute: fake.execute }), error => {
      assert.equal(error.message, 'MISSING_PINNED_PNPM')
      assert.equal(error.cause.errors.length, 2)
      return true
    })
  }
})

test('an unavailable cached Corepack version remains a failure with its cause', () => {
  const missing = new Error('COREPACK_NETWORK_DISABLED')
  const fake = fakeCommands({ pnpm: new Error('NOT_INSTALLED'), corepack: missing })
  assert.throws(() => resolvePinnedPnpm({ packageManager: pin, execute: fake.execute }), error => {
    assert.equal(error.message, 'MISSING_PINNED_PNPM')
    assert.equal(error.cause.errors[1], missing)
    return true
  })
})

test('version-only probes disable manager downloads and retain only local cache selectors', () => {
  const fake = fakeCommands({ pnpm: '11.0.0', corepack: '10.34.3' })
  const env = { PATH: '/fixture/bin', HOME: '/fixture/home', COREPACK_HOME: '/fixture/cache', XDG_CACHE_HOME: '/fixture/xdg',
    NODE_OPTIONS: '--require untrusted', GH_TOKEN: 'fixture-secret', HTTPS_PROXY: 'fixture-proxy',
    COREPACK_ENABLE_NETWORK: '1', npm_config_manage_package_manager_versions: 'true', pnpm_config_pm_on_fail: 'download' }
  resolvePinnedPnpm({ packageManager: pin, execute: fake.execute, env })
  for (const { options } of fake.calls) {
    assert.deepEqual(options.env, {
      PATH: env.PATH, HOME: env.HOME, COREPACK_HOME: env.COREPACK_HOME, XDG_CACHE_HOME: env.XDG_CACHE_HOME,
      NODE_OPTIONS: '', COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      COREPACK_ENABLE_AUTO_PIN: '0', COREPACK_ENABLE_PROJECT_SPEC: '0',
      npm_config_manage_package_manager_versions: 'false', pnpm_config_pm_on_fail: 'ignore',
    })
    assert.equal(options.timeout, 15_000)
    assert.equal(options.maxBuffer, 64 * 1024)
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe'])
    assert.equal(options.shell, undefined)
  }
  assert.equal(env.COREPACK_ENABLE_NETWORK, '1')
})

test('an integrity suffix is retained for Corepack while actual version output is still checked', () => {
  const integrityPin = `${pin}+sha512.${'a'.repeat(128)}`
  const fake = fakeCommands({ pnpm: '11.0.0', corepack: '10.34.3' })
  assert.deepEqual(resolvePinnedPnpm({ packageManager: integrityPin, execute: fake.execute }).args, [integrityPin])
})

test('unpinned managers fail before any command runs', () => {
  for (const packageManager of ['pnpm@latest', 'pnpm@^10.34.3', 'npm@10.34.3', 'pnpm@10.34.3;true']) {
    const fake = fakeCommands({})
    assert.throws(() => resolvePinnedPnpm({ packageManager, execute: fake.execute }), /INVALID_PINNED_PNPM/)
    assert.equal(fake.calls.length, 0)
  }
})


const scopeRoot = fileURLToPath(new URL('../..', import.meta.url))
const sharedInstallPath = '.github/actions/pnpm-install/action.yml'
const githubTokenExpression = '$' + '{{ github.token }}'
const inputTokenExpression = '$' + '{{ inputs.ffmpeg-github-token }}'
const syntheticToken = 'fixture-only-not-a-real-token'
const readYaml = path => yaml.load(readFileSync(join(scopeRoot, path), 'utf8'))
const sharedAction = () => readYaml(sharedInstallPath)
const sharedStep = job => job.steps.find(step => step.uses === './.github/actions/pnpm-install')
const apiReadOnly = permissions => permissions === 'read-all' || (
  permissions && typeof permissions === 'object' && permissions.contents === 'read' &&
  Object.entries(permissions).every(([key, value]) =>
    key === 'id-token' ? ['none', 'write'].includes(value) : ['none', 'read'].includes(value))
)
function assertCredentialScopes(workflow) {
  for (const [name, job] of Object.entries(workflow.jobs || {})) {
    const permissions = job.permissions ?? workflow.permissions
    const grants = [workflow.env?.FFMPEG_GITHUB_TOKEN, job.env?.FFMPEG_GITHUB_TOKEN]
    for (const step of job.steps || []) {
      grants.push(step.env?.FFMPEG_GITHUB_TOKEN)
      if (step.uses === './.github/actions/pnpm-install') grants.push(step.with?.['ffmpeg-github-token'])
    }
    for (const grant of grants.filter(value => value !== undefined && value !== '')) {
      assert.equal(grant, githubTokenExpression, 'ONLY_EXISTING_JOB_TOKEN')
      assert.ok(apiReadOnly(permissions), 'READ_ONLY_API_TOKEN_REQUIRED: ' + name)
    }
  }
}
function assertPublicImageBuild(build) {
  assert.ok(build, 'PUBLIC_IMAGE_BUILD_REQUIRED')
  assert.equal(build.env?.FFMPEG_GITHUB_TOKEN, undefined)
  if (typeof build.run === 'string') {
    assert.doesNotMatch(build.run, /--secret\s+[^\n]*ffmpeg_github_token/)
    return
  }
  assert.match(build.uses ?? '', /^docker\/build-push-action@[0-9a-f]{40}$/, 'PINNED_PUBLIC_IMAGE_ACTION_REQUIRED')
  const inputs = build.with ?? {}
  // Using the checked-out source avoids Buildx supplying Git auth to a remote context.
  assert.equal(inputs.context, '.', 'PUBLIC_IMAGE_LOCAL_CONTEXT_REQUIRED')
  for (const key of ['secrets', 'secret-envs', 'secret-files', 'github-token'])
    assert.ok(!inputs[key], `PUBLIC_IMAGE_SECRET_INPUT: ${key}`)
  for (const line of (inputs['build-args'] ?? '').split('\n').map(value => value.trim()).filter(Boolean)) {
    assert.match(line, /^[A-Za-z_][A-Za-z0-9_]*=/, 'PUBLIC_IMAGE_EXPLICIT_BUILD_ARG_REQUIRED')
    assert.doesNotMatch(line, /(?:ffmpeg[_-])?github[_-]token/i, 'PUBLIC_IMAGE_CREDENTIAL_BUILD_ARG')
    for (const match of line.matchAll(/\$\{\{(.*?)\}\}/g))
      assert.ok(['github.sha', 'steps.image-inputs.outputs.worker-sha'].includes(match[1].trim()), 'PUBLIC_IMAGE_NONPUBLIC_BUILD_ARG')
  }
}
function resolveInstallValue(value, inputs) {
  if (value === '') return ''
  if (value === githubTokenExpression) return syntheticToken
  if (value === inputTokenExpression) return inputs['ffmpeg-github-token'] ?? ''
  throw new Error('UNSUPPORTED_INSTALL_EXPRESSION')
}
function lifecyclePresence(t, caller, inherited = '') {
  const action = sharedAction()
  const install = action.runs.steps.filter(step => step.run === 'pnpm install --frozen-lockfile')
  assert.equal(install.length, 1)
  assert.equal(install[0].shell, 'bash')
  const value = caller.with?.['ffmpeg-github-token'] ?? action.inputs?.['ffmpeg-github-token']?.default ?? ''
  const inputs = { 'ffmpeg-github-token': resolveInstallValue(value, {}) }
  return installLifecyclePresence(t, install[0], inputs, inherited)
}
function installLifecyclePresence(t, install, inputs = {}, inherited = '') {
  assert.equal(install.run, 'pnpm install --frozen-lockfile')
  const directory = mkdtempSync(join(tmpdir(), 'mikka-install-scope-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name: 'mikka-credential-scope-fixture', version: '1.0.0', private: true,
    packageManager: pin, scripts: { postinstall: 'node postinstall.cjs' },
  }))
  writeFileSync(join(directory, 'pnpm-lock.yaml'),
    "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n")
  writeFileSync(join(directory, 'postinstall.cjs'),
    "require('node:fs').writeFileSync('presence.json', JSON.stringify({present: Boolean(process.env.FFMPEG_GITHUB_TOKEN)}))\n")
  const environment = {
    PATH: process.env.PATH, HOME: process.env.HOME, CI: 'true',
    NODE_OPTIONS: '', COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    npm_config_manage_package_manager_versions: 'false', npm_config_offline: 'true',
    npm_config_store_dir: join(directory, 'store'), FFMPEG_GITHUB_TOKEN: inherited,
  }
  for (const [key, value] of Object.entries(install.env || {})) {
    assert.equal(key, 'FFMPEG_GITHUB_TOKEN')
    environment[key] = resolveInstallValue(value, inputs)
  }
  const manager = resolvePinnedPnpm({ packageManager: pin })
  execFileSync(manager.file, [...manager.args, ...install.run.split(' ').slice(1)], {
    cwd: directory, env: environment, timeout: 30_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const receipt = JSON.parse(readFileSync(join(directory, 'presence.json'), 'utf8'))
  assert.deepEqual(Object.keys(receipt), ['present'])
  return receipt.present
}

test('shared install defaults to no credential and overrides ambient legacy tokens in real lifecycle scripts', async t => {
  const caller = sharedStep(readYaml('.github/workflows/self-hosted-image.yml').jobs.image)
  assert.ok(caller)
  assert.equal(caller.with?.['ffmpeg-github-token'], undefined)
  for (const inherited of ['', syntheticToken]) {
    await t.test(inherited ? 'ambient token is cleared' : 'no input stays empty', t => {
      assert.equal(lifecyclePresence(t, caller, inherited), false)
    })
  }
})

test('a verified API-read-only caller explicitly delivers its token to the real install process', t => {
  const workflow = readYaml('.github/workflows/ui-policy.yml')
  const caller = sharedStep(workflow.jobs['source-checks'])
  assert.equal(caller.with?.['ffmpeg-github-token'], githubTokenExpression)
  assertCredentialScopes(workflow)
  assert.equal(lifecyclePresence(t, caller), true)
})

test('the actual composite input and all workflow opt-ins preserve the process credential boundary', () => {
  const action = sharedAction()
  assert.equal(action.inputs['ffmpeg-github-token'].default, '')
  assert.equal(action.inputs['ffmpeg-github-token'].required, false)
  const install = action.runs.steps.find(step => step.run === 'pnpm install --frozen-lockfile')
  assert.equal(install.env.FFMPEG_GITHUB_TOKEN, inputTokenExpression)
  for (const name of readdirSync(join(scopeRoot, '.github/workflows')).filter(name => /\.ya?ml$/.test(name))) {
    assertCredentialScopes(readYaml('.github/workflows/' + name))
  }
  const image = readYaml('.github/workflows/self-hosted-image.yml').jobs.image
  const build = image.steps.find(step => step.name === 'Build the public standalone application')
  assertPublicImageBuild(build)
})

test('the public image action refuses secret channels and credential-bearing build arguments', () => {
  const build = { uses: 'docker/build-push-action@' + 'a'.repeat(40), with: { context: '.' } }
  const withInput = inputs => ({ ...build, with: { ...build.with, ...inputs } })
  for (const key of ['secrets', 'secret-envs', 'secret-files', 'github-token'])
    assert.throws(() => assertPublicImageBuild(withInput({ [key]: 'fixture' })), /PUBLIC_IMAGE_SECRET_INPUT/)
  assert.throws(() => assertPublicImageBuild(withInput({ context: undefined })), /PUBLIC_IMAGE_LOCAL_CONTEXT_REQUIRED/)
  assert.throws(() => assertPublicImageBuild(withInput({ 'build-args': 'IMPLICIT' })), /PUBLIC_IMAGE_EXPLICIT_BUILD_ARG_REQUIRED/)
  assert.throws(() => assertPublicImageBuild(withInput({ 'build-args': 'FFMPEG_GITHUB_TOKEN=fixture' })), /PUBLIC_IMAGE_CREDENTIAL_BUILD_ARG/)
  assert.throws(() => assertPublicImageBuild(withInput({ 'build-args': 'ALIAS=' + githubTokenExpression })), /PUBLIC_IMAGE_NONPUBLIC_BUILD_ARG/)
  assert.throws(() => assertPublicImageBuild({ uses: 'docker/build-push-action@main' }), /PINNED_PUBLIC_IMAGE_ACTION_REQUIRED/)
  assert.throws(() => assertPublicImageBuild({ run: 'docker build --secret id=ffmpeg_github_token .' }))
})

test('credential opt-ins honor job overrides and reject unknown or API-write permissions', async t => {
  for (const [name, workflowPermissions, jobPermissions, allowed] of [
    ['workflow read overridden by job write', { contents: 'read' }, { contents: 'write' }, false],
    ['workflow write overridden by job read', { contents: 'write' }, { contents: 'read' }, true],
    ['unknown inherited permissions', undefined, undefined, false],
    ['write-all', 'write-all', undefined, false],
    ['read-all', 'read-all', undefined, true],
    ['OIDC is separate from the API token', { contents: 'read', 'id-token': 'write' }, undefined, true],
    ['package publication token', { contents: 'read', packages: 'write' }, undefined, false],
    ['explicit empty permissions', { contents: 'read' }, {}, false],
  ]) {
    await t.test(name, () => {
      const job = { steps: [{ uses: './.github/actions/pnpm-install', with: { 'ffmpeg-github-token': githubTokenExpression } }] }
      if (jobPermissions !== undefined) job.permissions = jobPermissions
      const workflow = { jobs: { install: job } }
      if (workflowPermissions !== undefined) workflow.permissions = workflowPermissions
      if (allowed) assert.doesNotThrow(() => assertCredentialScopes(workflow))
      else assert.throws(() => assertCredentialScopes(workflow), /READ_ONLY_API_TOKEN_REQUIRED/)
      delete job.steps[0].with
      assert.doesNotThrow(() => assertCredentialScopes(workflow), 'anonymous/default-none remains allowed')
    })
  }
})

test('the actual Desktop runtime install passes its read-only token to real lifecycle scripts', t => {
  const workflow = readYaml('.github/workflows/desktop.yml')
  const native = workflow.jobs.smoke
  assert.ok(apiReadOnly(native.permissions ?? workflow.permissions))
  const installs = native.steps.filter(step => step.run === 'pnpm install --frozen-lockfile')
  assert.equal(installs.length, 1)
  assert.equal(installLifecyclePresence(t, installs[0]), true)
})

test('both desktop direct installs explicitly opt in under API-read-only permissions', () => {
  const workflow = readYaml('.github/workflows/desktop.yml')
  assertCredentialScopes(workflow)
  for (const name of ['checks', 'smoke']) {
    const job = workflow.jobs[name]
    assert.ok(apiReadOnly(job.permissions ?? workflow.permissions), name)
    const installs = job.steps.filter(step => step.run === 'pnpm install --frozen-lockfile')
    assert.equal(installs.length, 1, name)
    assert.equal(installs[0].env.FFMPEG_GITHUB_TOKEN, githubTokenExpression, name)
    if (name === 'checks') assert.equal(installs[0].env.ELECTRON_SKIP_BINARY_DOWNLOAD, '1')
  }
})
