import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { deployedRouteInventory } from './deployed-route-inventory.mjs'

const inventory = path => ({ version: 1, basePath: '/mikka', routes: [{ path, methods: ['GET'] }] })

async function fixture(t) {
  const repository = await mkdtemp(join(tmpdir(), 'mikka-route-inventory-'))
  t.after(() => rm(repository, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Route inventory test')
  git('config', 'user.email', 'route-inventory@example.invalid')
  await mkdir(join(repository, 'apps/api/generated'), { recursive: true })
  async function commit(manifest) {
    await writeFile(join(repository, 'apps/api/generated/routes.json'), JSON.stringify(manifest))
    git('add', '.')
    git('commit', '-m', 'Synthetic route inventory')
    return git('rev-parse', 'HEAD')
  }
  const first = await commit(inventory('/mikka/api/old'))
  const second = await commit(inventory('/mikka/api/current'))
  git('update-ref', 'refs/remotes/origin/main', second)
  let response = { status: 200, body: { build: first } }
  const requests = []
  const server = createServer((request, result) => {
    requests.push({ path: request.url, method: request.method, authorization: request.headers.authorization, cookie: request.headers.cookie })
    result.writeHead(response.status, { 'content-type': 'application/json' })
    result.end(JSON.stringify(response.body))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return { repository, git, commit, first, second, requests,
    origin: `http://127.0.0.1:${server.address().port}`,
    respond: value => { response = value } }
}

test('serving source chooses its immutable inventory even when main and the checkout are newer', async t => {
  const f = await fixture(t)
  const result = await deployedRouteInventory(f.origin, f.repository)
  assert.equal(result.source, f.first)
  assert.deepEqual(result.manifest, inventory('/mikka/api/old'))
  assert.deepEqual(f.requests, [{ path: '/mikka/api/version', method: 'GET', authorization: undefined, cookie: undefined }])
})

test('a valid-looking source outside main ancestry is refused before reading its inventory', async t => {
  const f = await fixture(t)
  f.git('checkout', '-b', 'unmerged')
  const unmerged = await f.commit(inventory('/mikka/api/unmerged'))
  f.respond({ status: 200, body: { build: unmerged } })
  await assert.rejects(deployedRouteInventory(f.origin, f.repository))
})

test('missing versions, malformed sources, and invalid manifests fail closed', async t => {
  const f = await fixture(t)
  for (const response of [
    { status: 503, body: { build: f.first } },
    { status: 200, body: {} },
    { status: 200, body: { build: 'main:package.json' } },
  ]) {
    f.respond(response)
    await assert.rejects(deployedRouteInventory(f.origin, f.repository), /route_inventory_/)
  }
  const invalid = await f.commit(inventory('/mikka/../write'))
  f.git('update-ref', 'refs/remotes/origin/main', invalid)
  f.respond({ status: 200, body: { build: invalid } })
  await assert.rejects(deployedRouteInventory(f.origin, f.repository), /route_probe_path_invalid/)
})

test('credential-bearing, remote plaintext and non-origin targets never receive a request', async t => {
  const f = await fixture(t)
  for (const origin of ['http://example.invalid', f.origin + '/private', f.origin + '/?token=synthetic', f.origin.replace('http://', 'http://name:synthetic@')]) {
    await assert.rejects(deployedRouteInventory(origin, f.repository), /route_inventory_origin_invalid/)
  }
  assert.equal(f.requests.length, 0)
})
