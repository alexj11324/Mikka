import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { GATEWAY_MODELS_URL, modelCatalog, resetModelCatalogForTests } from './model-catalog-server'
import { CATALOG_SNAPSHOT } from './model-catalog'

const live = { data: [
  { id: 'acme/tool-model', owned_by: 'acme', name: 'Tool Model', type: 'language', tags: ['tool-use'], pricing: { input: '0.000001', output: '0.000002' } },
  { id: 'anthropic/claude-opus-5.5', owned_by: 'anthropic', name: 'Claude Opus 5.5', type: 'language', tags: ['tool-use'], pricing: { input: '0.000005', output: '0.000025' } },
  { id: 'openai/gpt-image-2', owned_by: 'openai', type: 'image', tags: [] },
] }
let reads = 0
const answer = (body: unknown, status = 200) => (async (url: string | URL | Request) => {
  reads++
  assert.equal(String(url), GATEWAY_MODELS_URL)
  return Response.json(body, { status })
}) as typeof fetch

beforeEach(() => { resetModelCatalogForTests(); reads = 0 })

test('the live list is read once a day, chat models only, featured ones first', async () => {
  const first = await modelCatalog(answer(live), 0)
  assert.deepEqual(first.map(model => model.id), ['anthropic/claude-opus-5.5', 'acme/tool-model'])
  assert.equal(await modelCatalog(answer(live), 23 * 60 * 60 * 1000), first)
  assert.equal(reads, 1)
  await modelCatalog(answer(live), 25 * 60 * 60 * 1000)
  assert.equal(reads, 2)
})

test('an unreachable Gateway answers with the shipped snapshot and is tried again ten minutes later', async () => {
  assert.deepEqual(await modelCatalog(answer({ error: 'down' }, 503), 0), [...CATALOG_SNAPSHOT])
  await modelCatalog(answer(live), 5 * 60 * 1000)
  assert.equal(reads, 1)
  const recovered = await modelCatalog(answer(live), 11 * 60 * 1000)
  assert.equal(reads, 2)
  assert.equal(recovered.length, 2)
})
