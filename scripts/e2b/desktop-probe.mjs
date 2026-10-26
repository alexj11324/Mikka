// Run only in an empty disposable sandbox. Exact-operation approvals below are
// the operator's test fixture, not a production auto-approval policy.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { detectComputerDriver, executeDriver } from './driver.mjs'
import { ComputerBroker } from './broker.mjs'

const driver = await detectComputerDriver('/opt/mikka/computer/cua-driver')
assert.ok(driver, 'pinned driver')
const brokers = [1, 2].map(n => new ComputerBroker({
  driver, socketPath: `/tmp/probe-${n}.sock`, permitted: run => run === `probe-${n}`,
  execute: (d, call) => executeDriver(d, call, `:${n}`),
}))
async function approved(index, call) {
  const broker = brokers[index - 1]
  const grant = broker.spec(`probe-${index}`, 'ask')
  const result = broker.request(grant.token, call)
  const request = broker.list()[0]
  assert.ok(request)
  await broker.decide(request.id, request.digest, true)
  const value = await result
  assert.ok(!value.isError, 'driver must confirm success')
  await assert.rejects(broker.decide(request.id, request.digest, true))
  return value
}
function windowExists(n) {
  try { return Boolean(execFileSync('xdotool', ['search', '--name', `Mikka desktop ${n}`], { env: { ...process.env, DISPLAY: `:${n}` } }).toString().trim()) }
  catch { return false }
}
async function screenshot(n, name) {
  const result = await approved(n, { name: 'get_desktop_state', arguments: {} })
  const image = result.content?.find(item => item.type === 'image')
  assert.ok(image, 'actual screenshot data')
  await writeFile(`/tmp/${name}.png`, Buffer.from(image.data, 'base64'))
}
try {
  assert.ok(windowExists(1) && windowExists(2))
  await Promise.all([screenshot(1, 'desktop-1-before'), screenshot(2, 'desktop-2-before')])
  const geometry = execFileSync('xwininfo', ['-name', 'Mikka desktop 1'], { env: { ...process.env, DISPLAY: ':1' } }).toString()
  const x = Number(geometry.match(/Absolute upper-left X:\s+(\d+)/)?.[1])
  const y = Number(geometry.match(/Absolute upper-left Y:\s+(\d+)/)?.[1])
  const height = Number(geometry.match(/Height:\s+(\d+)/)?.[1])
  assert.ok(Number.isFinite(x + y + height))
  await approved(1, { name: 'click', arguments: { x: x + 15, y: y + height - 15 } })
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(windowExists(1), false, 'approved click dismissed desktop 1 dialog')
  assert.equal(windowExists(2), true, 'desktop 2 unchanged')
  await Promise.all([screenshot(1, 'desktop-1-after'), screenshot(2, 'desktop-2-after')])
  console.log(JSON.stringify({ pinnedDriver: true, concurrentScreenshots: true, approvedClick: true, displayIsolation: true, replayDenied: true }))
} finally { await Promise.all(brokers.map(b => b.close())) }
