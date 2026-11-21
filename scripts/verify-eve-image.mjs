import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyResources } from './cloudflare-runtime-release.mjs'

/** Validate bytes extracted from the built image against the compiler's manifest. */
export async function verifyEveImagePayload(directory, manifest, { sourceSha, releaseId }) {
  const read = path => readFile(join(directory, path), 'utf8').then(JSON.parse)
  assert.equal(manifest.revision, sourceSha)
  assert.ok(Array.isArray(manifest.resources) && manifest.resources.length > 0)
  assert.equal(new Set(manifest.resources.map(value => value.path)).size, manifest.resources.length)
  assert.deepEqual(await read('eve-host.json'), {
    version: 1, sourceSha, uiSha: sourceSha, releaseId, uiSource: 'public-server',
  })
  assert.deepEqual(await read('eve/mikka-eve-build.json'), {
    version: 1, eve: '1.3.0', revision: sourceSha, preset: 'node-server',
    world: '@workflow/world-postgres', worldVersion: '5.4.1',
  })
  await verifyResources(join(directory, 'eve'), manifest.resources)
}

async function main(image) {
  assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/, 'Use the immutable local image ID')
  const run = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
  const built = JSON.parse(run(['image', 'inspect', image, '--format', '{{json .}}']))
  assert.equal(built.Id, image)
  assert.equal(built.Config.User, 'node')
  assert.equal(built.Config.WorkingDir, '/app/eve')
  assert.deepEqual(built.Config.Cmd, ['node', 'server/index.mjs'])
  const directory = await mkdtemp(join(tmpdir(), 'mikka-eve-image-'))
  let container
  try {
    container = run(['create', '--network', 'none', image])
    run(['cp', container + ':/app/eve', join(directory, 'eve')])
    run(['cp', container + ':/app/eve-host.json', join(directory, 'eve-host.json')])
    const manifest = JSON.parse(await readFile('.output/mikka-build.json', 'utf8'))
    await verifyEveImagePayload(directory, manifest, {
      sourceSha: process.env.MIKKA_BUILD_REVISION, releaseId: process.env.MIKKA_DEPLOYMENT_ID,
    })
    run(['run', '--rm', '--network', 'none', '--entrypoint', 'node', image, '--check', 'server/index.mjs'])
    console.log(JSON.stringify({ image, verification: 'packaged-resources-and-entry-syntax', resources: manifest.resources.length }))
  } finally {
    try { if (container) run(['rm', container]) }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv[2])
