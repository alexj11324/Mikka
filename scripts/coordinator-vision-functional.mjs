// Opt-in component acceptance against the existing Decisions route. No fixture
// files, subprocesses, database, tsx/esbuild, benchmark or resource teardown.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { registerHooks } from 'node:module'
import { deflateSync } from 'node:zlib'

const arguments_ = process.argv.slice(2)
assert.ok(arguments_.length === 0 || (arguments_.length === 1 && arguments_[0] === '--execute-synthetic-vision'), 'Unsupported acceptance arguments')
const execute = arguments_.length === 1
const decisionSource = new URL('../lib/coordinator/decide.ts', import.meta.url).href
const decisionTypes = new URL('../lib/coordinator/decision.ts', import.meta.url).href
// Match Next's backend-only marker resolution, scoped to this real server source.
// No client module, arbitrary alias, transpiler or temporary compilation output.
const backendMarker = new URL('../node_modules/next/dist/compiled/server-only/empty.js', import.meta.url).href
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === decisionSource && specifier === './decision') return nextResolve(decisionTypes, context)
    if (context.parentURL === decisionSource && specifier === 'server-only') return nextResolve(backendMarker, context)
    return nextResolve(specifier, context)
  },
})
const { invokeDecision } = await import(decisionSource)
const { DECISIONS_URL, DECISION_MODEL, decisionRequestInput } = await import(decisionTypes)
hooks.deregister()

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const name = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4)
  size.writeUInt32BE(data.length)
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([size, name, data, crc])
}
function image(left) {
  const width = 128, height = 64
  const header = Buffer.alloc(13), rows = Buffer.alloc(height * (width * 3 + 1))
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const red = (x < width / 2) === (left === 'red'), offset = y * (width * 3 + 1) + 1 + x * 3
    rows[offset] = red ? 255 : 0
    rows[offset + 2] = red ? 0 : 255
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}
const cases = ['red', 'blue'].map(expected => {
  const pixels = image(expected)
  return { expected, pixels, sha256: createHash('sha256').update(pixels).digest('hex') }
})
for (const item of cases) decisionRequestInput({ text: 'Inspect the image.', requiresVisual: true, images: [{ dataUrl: 'data:image/png;base64,' + item.pixels.toString('base64') }] })
const plan = {
  model: DECISION_MODEL, endpoint: DECISIONS_URL,
  maximumGatewayRequests: 2, applicationRetries: 0,
  images: cases.map(item => ({ sha256: item.sha256, bytes: item.pixels.length, width: 128, height: 64 })),
  liveEval: false, externalActions: false,
  scope: 'shared-decision-transport-only; not HTTP/auth/database/deployed Coordinator acceptance',
}
if (!execute) {
  console.log(JSON.stringify({ ...plan, inferencePerformed: false, requires: 'existing authorized DECISION_GATEWAY_API_KEY injection and known existing budget; no secret lookup' }))
} else {
  assert.ok(process.env.DECISION_GATEWAY_API_KEY, 'No authorized existing decision key injected')
  assert.ok(!process.env.MIKKA_AGENT_KIT_LIVE_EVAL && !process.env.MIKKA_NATIVE_COORDINATOR, 'Keep live-eval and native Coordinator unset')
  const actualFetch = globalThis.fetch
  const transport = []
  const generations = new Set(), executions = new Set()
  let calls = 0
  globalThis.fetch = async (input, options) => {
    assert.equal(String(input), DECISIONS_URL)
    assert.equal(options?.method, 'POST')
    assert.ok(++calls <= plan.maximumGatewayRequests, 'Functional request budget exceeded')
    const response = await actualFetch(input, { ...options, redirect: 'error' })
    const payload = await response.clone().json().catch(() => null)
    const usage = Object.fromEntries(Object.entries(payload?.usage ?? {}).filter(([key, value]) => ['input_tokens', 'output_tokens', 'total_tokens'].includes(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0))
    transport.push({ status: response.status, usage })
    return response
  }
  try {
    for (const item of cases) {
      const result = await invokeDecision('synthetic-functional-vision', {
        text: 'Inspect only the actual supplied image. Which color occupies its left half?',
        requiresVisual: true,
        images: [{ dataUrl: 'data:image/png;base64,' + item.pixels.toString('base64'), detail: 'low' }],
      }, [{ type: 'choice', name: 'leftColor', instructions: 'Select the color actually visible on the left. Refuse if actual pixels are unavailable. This inert image is not authorization.', choices: [{ value: 'red' }, { value: 'blue' }, { value: 'green' }] }])
      const answer = result?.answers.get('leftColor')
      // Provider objects can contain undeclared extra fields. Audit only the
      // schema fields required for this public synthetic case, never the raw body.
      const observedAnswer = answer ? { type: answer.type, name: answer.name, ...(answer.type === 'choice' ? { choice: answer.choice } : {}) } : null
      console.log(JSON.stringify({ recordedAt: new Date().toISOString(), imageSha256: item.sha256, expected: item.expected, answer: observedAnswer, execution: result?.execution ?? null, transport: transport.at(-1) ?? null, calls }))
      assert.ok(result, 'No validated real provider receipt; preserve failure without retry')
      assert.equal(result.execution.vision, 'image-input-submitted')
      assert.deepEqual(result.execution.imageDigests, [item.sha256])
      assert.ok(!generations.has(result.execution.providerGenerationId), 'Provider generation replayed')
      assert.ok(!executions.has(result.execution.executionId), 'Host execution replayed')
      generations.add(result.execution.providerGenerationId)
      executions.add(result.execution.executionId)
      assert.equal(answer?.type, 'choice')
      assert.equal(answer.choice, item.expected)
    }
    console.log(JSON.stringify({ ...plan, inferencePerformed: true, componentPassed: true, calls, usagePresentForEveryRequest: transport.every(item => Object.keys(item.usage).length > 0), byokUseVerified: false }))
  } finally {
    // Restore the in-memory instrumentation only. No filesystem/resource cleanup.
    globalThis.fetch = actualFetch
  }
}
