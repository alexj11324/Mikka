import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { recordOverlay, productionOverlay, assertNoSourceMaps, desktopOverlayEvidence } from './hosted-ui.mjs'
const require = createRequire(import.meta.url)
const yaml = require('js-yaml')
const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40)
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'hosted-ui-'))
  t.after(() => rm(path, { force: true, recursive: true }))
  return path
}
test('records an immutable private checkout and rejects mismatch before exporting build env', async t => {
  const path = await directory(t), envFile = join(path, 'env')
  execFileSync('git', ['init', '-q', path])
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: path })
  const { overlaySha } = await recordOverlay(path, { env: { GITHUB_ENV: envFile } })
  assert.match(overlaySha, /^[a-f0-9]{40}$/)
  const before = await readFile(envFile, 'utf8')
  assert.equal(before, `MIKKA_UI_OVERLAY_DIR=${path}\nMIKKA_UI_OVERLAY_SHA=${overlaySha}\n`)
  await assert.rejects(recordOverlay(path, { env: { GITHUB_ENV: envFile, MIKKA_UI_OVERLAY_SHA: SHA } }), /checkoutMismatch/)
  assert.equal(await readFile(envFile, 'utf8'), before)
  const cleared = join(path, 'cleared-env')
  await recordOverlay(path, { env: { GITHUB_ENV: cleared, HOSTED_UI_READ_KEY: 'private-key-sentinel' } })
  const exported = await readFile(cleared, 'utf8')
  assert.ok(exported.endsWith('HOSTED_UI_READ_KEY=\n'))
  assert.ok(!exported.includes('private-key-sentinel'))
})
test('requires a real Web source and matching overlay, with no credentials on the public request', async () => {
  const options = { expectedOverlay: SHA, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://app.aspectlylabs.com/mikka/api/version')
    assert.equal(init.cache, 'no-store'); assert.equal(init.headers.authorization, undefined)
    return Response.json({ build: OTHER, overlaySha: SHA })
  } }
  assert.deepEqual(await productionOverlay(options), { webBuild: OTHER, overlaySha: SHA })
  await assert.rejects(productionOverlay({ ...options, expectedOverlay: OTHER }), /productionOverlayMismatch/)
  for (const overlaySha of [null, '', 'main', '../source']) await assert.rejects(productionOverlay({ fetchImpl: async () => Response.json({ build: OTHER, overlaySha }) }), /overlayShaRequired/)
})
test('distribution rejects source maps, inline maps, raw UI source and escaping links without exposing paths or content', async t => {
  const path = await directory(t)
  for (const [name, content] of [ ['avatar.js.map', '{}'], ['avatar.js', '//# sourceMappingURL=data:application/json;base64,e30='], ['avatar.css', '/*# sourceMappingURL=avatar.css.map */'], ['avatar.json', '{"sourcesContent":["private"]}'], ['avatar.tsx', 'private source'] ]) {
    await writeFile(join(path, name), content)
    await assert.rejects(assertNoSourceMaps(path), error => /^hostedUi:(sourceInOutput|sourceMapInOutput)$/.test(error.message))
    await rm(join(path, name))
  }
  await symlink('/etc/hostname', join(path, 'escape'))
  await assert.rejects(assertNoSourceMaps(path), /outputOutsideRoot/)
  await rm(join(path, 'escape'))
  await writeFile(join(path, 'avatar.js'), 'export const avatar="compiled";')
  assert.deepEqual(await assertNoSourceMaps(path), { sourceMaps: 0, files: 1 })
  await desktopOverlayEvidence(path, SHA)
  assert.deepEqual(JSON.parse(await readFile(join(path, 'mikka-ui-overlay.json'))), { overlaySha: SHA })
})
test('official jobs keep private code out of public artifacts and pin desktop to Web', async () => {
  const workflow = async name => yaml.load(await readFile(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'))
  const desktop = await workflow('desktop-release')
  for (const job of Object.values(desktop.jobs)) {
    for (const step of job.steps ?? []) assert.ok(!step.uses?.startsWith('actions/upload-artifact'))
  }
  const install = desktop.jobs.macos.steps.find(step => step.name === 'Install private UI runtime dependencies without license scripts')
  assert.match(install?.run ?? '', /--ignore-workspace --prod --ignore-scripts --frozen-lockfile/)
  for (const job of [desktop.jobs.preflight, desktop.jobs.macos]) {
    assert.ok(!job.steps.some(step => /web-deploy\.mjs|hosted-ui\.mjs production/.test(step.run ?? '')))
    assert.equal(job.permissions.issues, 'read')
  }
  const proof = 'node scripts/release/cloudflare-promoted-web.mjs desktop'
  const approved = job => job.steps.filter(step => step.run === proof)
  assert.equal(approved(desktop.jobs.preflight).length, 1)
  assert.equal(approved(desktop.jobs.macos).length, 2)
  const { preflight, macos } = desktop.jobs
  // A push builds nothing. A dispatch's receipt, or the receipt of the Cloudflare gateway observation
  // that started this run, is verified in preflight, and only that unlocks macOS.
  assert.deepEqual(Object.keys(desktop.on).sort(), ['push', 'workflow_dispatch', 'workflow_run'])
  assert.deepEqual(desktop.on.workflow_run, { workflows: ['Cloudflare application deployment'], types: ['completed'] })
  const trigger = preflight.steps.find(step => step.id === 'trigger')
  assert.equal(trigger.if, "github.event_name == 'workflow_run'")
  assert.equal(trigger.run, 'node scripts/release/cloudflare-promoted-web.mjs trigger desktop')
  assert.equal(approved(preflight)[0].env.CLOUDFLARE_RECEIPT, '${{ github.event.inputs.cloudflare_receipt || steps.trigger.outputs.receipt }}')
  assert.equal(approved(preflight)[0].if, "github.event_name == 'workflow_dispatch' || steps.trigger.outputs.ready == 'true'")
  assert.ok(preflight.steps.indexOf(trigger) < preflight.steps.indexOf(approved(preflight)[0]))
  assert.equal(preflight.outputs.receipt, '${{ github.event.inputs.cloudflare_receipt || steps.trigger.outputs.receipt }}')
  for (const step of approved(macos)) {
    assert.equal(step.if, undefined)
    assert.equal(step.env.CLOUDFLARE_RECEIPT, '${{ needs.preflight.outputs.receipt }}')
  }
  assert.equal(preflight.outputs.release, "${{ steps.promoted.outcome == 'success' }}")
  assert.equal(macos.if, "needs.preflight.outputs.release == 'true'")
  const missing = preflight.steps.find(step => step.name === 'Require the Cloudflare promotion receipt')
  assert.equal(missing.if, "github.event_name == 'workflow_dispatch' && github.event.inputs.cloudflare_receipt == ''")
  assert.match(missing.run, /exit 1/)
  assert.ok(preflight.steps.indexOf(missing) < preflight.steps.indexOf(approved(preflight)[0]))
  assert.equal(preflight.outputs['overlay-sha'], '${{ steps.promoted.outputs.overlay-sha }}')
  assert.equal(preflight.env.EXPECTED_UI_OVERLAY_SHA, '${{ inputs.overlay-sha }}')
  assert.equal(macos.env.MIKKA_UI_OVERLAY_SHA, '${{ needs.preflight.outputs.overlay-sha }}')
  const signing = macos.steps
  assert.ok(signing.findIndex(step => step.run?.includes('evidence.mjs verify')) < signing.indexOf(approved(macos)[1]))
  assert.ok(signing.indexOf(approved(desktop.jobs.macos)[0]) < signing.findIndex(step => step.uses?.startsWith('Infisical/')))
  assert.equal(signing.indexOf(approved(desktop.jobs.macos)[1]) + 1, signing.findIndex(step => step.uses?.startsWith('softprops/')))
  assert.ok(signing.some(step => step.run?.includes('evidence.mjs verify')))
  const checkout = desktop.jobs.macos.steps.find(step => step.with?.path === '.hosted-ui')
  assert.equal(checkout.with.ref, '${{ needs.preflight.outputs.overlay-sha }}')
  assert.equal(checkout.with['persist-credentials'], false)
  assert.equal(checkout.with['ssh-key'], '${{ env.HOSTED_UI_READ_KEY }}')
  assert.equal(checkout.with.token, undefined)
  assert.ok(desktop.jobs.macos.steps.some(step => step.run?.includes('audit "$RUNNER_TEMP/official-packaged-app"')))
})
test('native release admission requires a coherent official identity before credentials or paid work', async () => {
  for (const [file, job] of [['desktop-release', 'preflight'], ['mobile-update', 'update'], ['mobile-native', 'release'], ['e2b-official-runtime', 'check'], ['e2b-runtime-release', 'recheck'], ['e2b-runtime-release', 'cleanup'], ['e2b-template', 'build'], ['publish-daemon', 'publish']]) {
    const workflow = yaml.load(await readFile(new URL(`../../.github/workflows/${file}.yml`, import.meta.url), 'utf8'))
    const allowed = new Function('github', 'needs', 'always', `return ${workflow.jobs[job].if ?? "true"}`)
    for (const repository of ['alexj11324/Mikka', 'aspectly-labs/Mikka', 'foreign/Mikka']) {
      for (const repository_id of ['1427517699', '999']) {
        for (const repository_owner_id of ['183887963', '359279274', '999']) {
          const github = { repository, repository_id, repository_owner_id, ref: 'refs/heads/main', event_name: 'workflow_dispatch' }
          const expected = repository_id === '1427517699' && ((repository === 'alexj11324/Mikka' && repository_owner_id === '183887963') || (repository === 'aspectly-labs/Mikka' && repository_owner_id === '359279274'))
          assert.equal(allowed(github, { recheck: { result: 'success', outputs: {} } }, () => true), expected, `${file}:${job}:${JSON.stringify(github)}`)
        }
      }
    }
  }
})
test('native private UI selection rejects unknown owners before reading credentials', async () => {
  for (const [file, job] of [['desktop-release', 'macos'], ['mobile-update', 'update'], ['mobile-native', 'release']]) {
    const workflow = yaml.load(await readFile(new URL(`../../.github/workflows/${file}.yml`, import.meta.url), 'utf8'))
    const steps = workflow.jobs[job].steps
    const check = steps.find(step => step.name === 'Validate the selected private UI owner before credential access')
    assert.ok(check, `${file}: private owner validation is required`)
    assert.ok(steps.indexOf(check) < steps.findIndex(step => step.uses?.startsWith('Infisical/')), file)
    const checkout = steps.find(step => step.with?.path === '.hosted-ui')
    const select = new Function('vars', 'format', `return ${checkout.with.repository.slice(3, -3)}`)
    for (const owner of ['', 'alexj11324', 'aspectly-labs', 'foreign']) {
      const run = () => execFileSync('bash', ['-e', '-c', check.run], { cwd: new URL('../../', import.meta.url), env: { ...process.env, MIKKA_PRIVATE_GITHUB_OWNER: owner }, stdio: 'pipe' })
      if (owner === 'foreign') assert.throws(run, /CI_PRIVATE_REPOSITORY_OWNER_REQUIRED/)
      else {
        run()
        assert.equal(select({ MIKKA_PRIVATE_GITHUB_OWNER: owner }, (_, value) => `${value}/mikka-hosted-ui`), `${owner || 'alexj11324'}/mikka-hosted-ui`)
      }
    }
  }
})
test('daemon metadata follows official Actions identities while fork builds retain the canonical source', async () => {
  const script = await readFile(new URL('../../packages/daemon/scripts/build.mjs', import.meta.url), 'utf8')
  // Exercise only the metadata preflight; do not start a local package build.
  const preflight = script.slice(script.indexOf('const repository ='), script.indexOf('const root ='))
  const select = new Function('process', `${preflight}; return repository`)
  const url = new Function('repository', `return ${script.match(/repository: \{ type: 'git', url: (.+), directory:/)[1]}`)
  assert.equal(url(select({ env: {} })), 'git+https://github.com/alexj11324/Mikka.git')
  for (const [owner, id] of [['alexj11324', '183887963'], ['aspectly-labs', '359279274']]) {
    const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: `${owner}/Mikka`, GITHUB_REPOSITORY_ID: '1427517699', GITHUB_REPOSITORY_OWNER_ID: id }
    assert.equal(url(select({ env })), `git+https://github.com/${owner}/Mikka.git`)
    for (const patch of [{ GITHUB_REPOSITORY: 'foreign/Mikka' }, { GITHUB_REPOSITORY_ID: '1' }, { GITHUB_REPOSITORY_OWNER_ID: id === '183887963' ? '359279274' : '183887963' }]) {
      assert.equal(url(select({ env: { ...env, ...patch } })), 'git+https://github.com/alexj11324/Mikka.git')
    }
  }
})
