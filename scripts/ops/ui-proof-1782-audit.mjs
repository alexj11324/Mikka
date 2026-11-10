import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PRODUCT, PRODUCT_TREE, OVERLAY, PUBLIC_TARGETS, REQUIRED_SLOTS, validateSemanticChecks, validateWorkspaceNameCleanup } from './ui-proof-1782.mjs'

try {
  const app = resolve(process.env.MIKKA_TEST_APP_DIR)
  const output = resolve(process.env.MIKKA_UI_PROOF_OUTPUT)
  process.chdir(app)
  const { auditEvidence } = await import(pathToFileURL(join(app, 'scripts/test-accounts/session.mjs')).href)
  const { loadEnvironment } = await import(pathToFileURL(join(app, 'scripts/test-accounts/environment.mjs')).href)
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
  const source = JSON.parse(await readFile(join(output, 'source-pair.json'), 'utf8'))
  assert.equal(manifest.product, PRODUCT); assert.equal(manifest.productTree, PRODUCT_TREE); assert.equal(manifest.overlay, OVERLAY)
  assert.equal(source.product, PRODUCT); assert.equal(source.productTree, PRODUCT_TREE); assert.equal(source.overlay, OVERLAY)
  assert.equal(source.inventorySemantics, 'transformed_source_modules_not_render_coverage')
  assert.deepEqual(source.targets.map(target => target.path), PUBLIC_TARGETS)
  assert.ok(source.targets.every(target => target.includedInProductionBuild === true && /^[a-f0-9]{64}$/.test(target.sha256)))
  assert.deepEqual(source.slots.map(slot => slot.name), REQUIRED_SLOTS)
  assert.ok(source.slots.every(slot => slot.privateOverlaySelected === true && slot.includedInProductionBuild === true))
  assert.match(source.build.inventorySha256, /^[a-f0-9]{64}$/)
  assert.match(source.build.rendererBuild, /^[a-f0-9]{64}$/)
  assert.equal(manifest.responseMocks, 0); assert.equal(manifest.synthetic, true); assert.equal(manifest.productionAcceptance, false)
  assert.equal(manifest.edition, 'cloud'); assert.equal(manifest.externalCloudServiceConfigured, false)
  if (process.env.CAPTURE_OUTCOME === 'success') {
    assert.equal(manifest.result, 'passed'); assert.equal(manifest.screens.length, 20); assert.equal(manifest.checks.length, 12)
    validateSemanticChecks(manifest.checks)
    assert.equal(manifest.compiled.revision, PRODUCT); assert.equal(manifest.compiled.rendererBuild, source.build.rendererBuild)
    assert.equal(manifest.compiled.servedBuildMatches, true); assert.equal(manifest.compiled.servedOverlayMatches, true)
    assert.ok(Object.values(manifest.cleanup).every(value => value === true))
    validateWorkspaceNameCleanup(manifest.workspaceNameCleanup)
    manifest.runtimeShutdown = 'passed'
  } else {
    manifest.result = 'failed'; manifest.runtimeShutdown = 'unproven'
  }
  const expected = ['index.html', 'manifest.json', 'source-pair.json', ...manifest.screens.map(screen => screen.filename)].sort()
  assert.equal(new Set(expected).size, expected.length)
  assert.deepEqual((await readdir(output)).sort(), expected)
  for (const filename of expected) {
    assert.ok(/^(?:index\.html|manifest\.json|source-pair\.json|(?:wide|narrow)-(?:light|dark)-(?:empty-dispatcher|task-groups-expanded|human-and-delegate|delegation-and-history|project-error-editable)\.png)$/.test(filename))
    const stat = await lstat(join(output, filename))
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 10 * 1024 * 1024)
  }
  for (const screen of manifest.screens) {
    const bytes = await readFile(join(output, screen.filename))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), screen.sha256)
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    assert.equal(bytes.readUInt32BE(16), screen.viewport.width)
    assert.equal(bytes.readUInt32BE(20), screen.viewport.height)
  }
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await auditEvidence([output], { environment: await loadEnvironment() })
  console.log(JSON.stringify({ status: 'gallery_audited', result: manifest.result, files: expected.length, screenshots: manifest.screens.length,
    product: PRODUCT, overlay: OVERLAY, runtimeShutdown: manifest.runtimeShutdown }))
} catch {
  console.error('UI_PROOF_ARTIFACT_AUDIT_FAILED')
  process.exitCode = 1
}
