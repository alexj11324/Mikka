import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { compareImages } from './parity-images.mjs'

const [beforePath, afterPath, destination] = process.argv.slice(2)
assert.ok(beforePath && afterPath && destination, 'Usage: compare-web-parity.mjs <before/parity> <after/parity> <diff-output>')
const before = JSON.parse(await readFile(join(beforePath, 'parity.json'), 'utf8'))
const after = JSON.parse(await readFile(join(afterPath, 'parity.json'), 'utf8'))
assert.equal(before.mode, 'web-capture'); assert.equal(after.mode, 'web-capture')
assert.equal(before.result, 'passed'); assert.equal(after.result, 'passed')
assert.equal(before.cleanup, 'passed'); assert.equal(after.cleanup, 'passed')
assert.deepEqual(before.requiredScreens, after.requiredScreens)
assert.deepEqual(before.themes, after.themes)
assert.deepEqual(before.viewport, after.viewport)
assert.notEqual(before.environmentId, after.environmentId, 'Before and after require independently attested environments')
const output = resolve(destination)
await mkdir(output, { recursive: true })
const report = { version: 1, before: { appRevision: before.appRevision, harnessRevision: before.harnessRevision, harnessSha256: before.harnessSha256, environmentId: before.environmentId }, after: { appRevision: after.appRevision, harnessRevision: after.harnessRevision, harnessSha256: after.harnessSha256, environmentId: after.environmentId }, screens: [] }
for (const previous of before.screens) {
  const current = after.screens.find(screen => screen.name === previous.name && screen.theme === previous.theme)
  assert.ok(current, `Missing ${previous.theme}/${previous.name}`)
  const comparison = await compareImages({ bytes: await readFile(join(beforePath, previous.filename)), masks: previous.masks }, { bytes: await readFile(join(afterPath, current.filename)), masks: current.masks }, join(output, `${previous.theme}-${previous.name}-diff.png`))
  report.screens.push({ name: previous.name, theme: previous.theme, ...comparison })
  console.log(`${comparison.passed ? 'PASS' : 'FAIL'} ${previous.theme}/${previous.name}: ${(comparison.changedRatio * 100).toFixed(5)}%`)
}
report.result = report.screens.every(screen => screen.passed) ? 'passed' : 'failed'
await writeFile(join(output, 'web-parity.json'), `${JSON.stringify(report, null, 2)}\n`)
assert.equal(report.result, 'passed', 'Every before/after web screenshot must differ by at most 0.1%')
