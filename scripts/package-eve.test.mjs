import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { eveFunctionWrapper, eveVercelRoutes, packageEve } from './package-eve.mjs'

test('Vercel wrapper runs the upstream fetch handler with native request context and isolated paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'eve-vercel-wrapper-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'upstream.mjs'), `export default { async fetch(request, context) { return Response.json({ url: request.url, body: await request.text(), wait: typeof context.waitUntil }) } }`)
  await writeFile(join(root, 'wrapper.mjs'), eveFunctionWrapper('upstream.mjs'))
  const service = (await import(pathToFileURL(join(root, 'wrapper.mjs')).href)).default
  for (const [path, target] of [
    ['/mikka/api/agents/eve/v1/session?botId=one', '/eve/v1/session?botId=one'],
    ['/mikka/api/agents/.well-known/workflow/v1/flow', '/.well-known/workflow/v1/flow'],
    ['/_mikka_eve/.well-known/workflow/v1/flow', '/.well-known/workflow/v1/flow'],
    ['/mikka/api/webhooks/slack', '/eve/v1/slack'],
  ]) {
    const response = await service.fetch(new Request(`https://app.test${path}`, { method: 'POST', body: 'raw signed input' }), { waitUntil() {} })
    assert.deepEqual(await response.json(), { url: `https://app.test${target}`, body: 'raw signed input', wait: 'function' })
  }
  const routes = eveVercelRoutes()
  assert.equal(routes.some(route => new RegExp(route.src).test('/.well-known/workflow/v1/flow')), false, 'the main app queue stays owned by its own function')
})

test('prebuilt packaging keeps queue triggers and rejects mixed app/agent revisions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'eve-packaging-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const output = join(root, '.vercel/output'), source = join(root, 'apps/eve/.output')
  const functionPath = 'functions/.well-known/workflow/v1/flow.func'
  await mkdir(join(source, functionPath), { recursive: true })
  await mkdir(join(output, 'functions/app.func'), { recursive: true })
  const revision = 'a'.repeat(40)
  const agent = { version: 1, revision, eve: '1.0.0-rc.9', preset: 'vercel' }
  const contract = { handler: 'index.mjs', runtime: 'nodejs24.x', experimentalTriggers: [{ type: 'queue/v2beta', topic: '__eve_fixture_workflow_*' }] }
  const save = (path, value) => writeFile(path, JSON.stringify(value))
  await save(join(source, 'mikka-eve-build.json'), agent)
  await save(join(source, 'config.json'), { version: 3, routes: [], crons: [{ path: '/eve/v1/cron/run', schedule: '* * * * *' }] })
  await save(join(source, functionPath, '.vc-config.json'), contract)
  await writeFile(join(source, functionPath, 'index.mjs'), 'export default { fetch() {} }')
  await save(join(output, 'config.json'), { version: 3, routes: [{ src: '/(.*)', dest: '/app' }] })
  await save(join(output, 'mikka-build.json'), { revision: 'b'.repeat(40), resources: [], functions: [{ path: 'functions/app.func' }] })
  await assert.rejects(packageEve({ root, preset: 'vercel' }), /EVE_APP_BUILD_MISMATCH/)
  await save(join(output, 'mikka-build.json'), { revision, resources: [], functions: [{ path: 'functions/app.func' }] })
  await packageEve({ root, preset: 'vercel' })
  const packaged = JSON.parse(await readFile(join(output, 'functions/_mikka_eve/.well-known/workflow/v1/flow.func/.vc-config.json'), 'utf8'))
  assert.deepEqual(packaged.experimentalTriggers, contract.experimentalTriggers)
  assert.equal(packaged.environment.EVE_PUBLIC_ROUTE_PREFIX, '/mikka/api/agents')
  assert.equal(packaged.supportsCancellation, true)
  const config = JSON.parse(await readFile(join(output, 'config.json'), 'utf8'))
  assert.deepEqual(config.routes.slice(0, 2), eveVercelRoutes())
  assert.equal(config.crons[0].path, '/mikka/api/agents/eve/v1/cron/run')
})
