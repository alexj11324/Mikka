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
  const web = await workflow('web-deploy'), desktop = await workflow('desktop-release')
  for (const doc of [web, desktop]) for (const job of Object.values(doc.jobs)) {
    for (const step of job.steps ?? []) assert.ok(!step.uses?.startsWith('actions/upload-artifact'))
  }
  const checkout = desktop.jobs.macos.steps.find(step => step.with?.repository === 'alexj11324/mikka-hosted-ui')
  assert.equal(checkout.with.ref, '${{ needs.preflight.outputs.overlay-sha }}')
  assert.equal(checkout.with['persist-credentials'], false)
  assert.ok(desktop.jobs.macos.steps.some(step => step.run?.includes('audit "$RUNNER_TEMP/official-packaged-app"')))
  assert.ok(web.jobs.deploy.steps.some(step => step.run?.includes('audit .vercel/output/static')))
})
