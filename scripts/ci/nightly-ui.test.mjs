import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { restoreNightlyUi, selectNightlyUi } from './nightly-ui.mjs'
import { rendererActionContract } from '../../lib/renderer-actions.mjs'

const source = 'a'.repeat(40), webSource = 'b'.repeat(40), overlay = 'c'.repeat(40)
const identity = { id: 1427517699, full_name: 'alexj11324/Mikka', private: false, fork: false }
const run = { id: 101, run_attempt: 1, head_sha: source, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success',
  path: '.github/workflows/cloudflare-api-image.yml', actor: { id: 183887963 }, triggering_actor: { id: 183887963 }, repository: identity, head_repository: identity }

function archive(extra = [], proofOverrides = {}, actionsOverride) {
  const proof = { version: 1, target: 'web', rendererBuild: 'd'.repeat(64), usedActions: ['tasks.read'], modules: { tasks: ['read'] },
    inputs: ['.hosted-ui/slots/synthetic-fixture.tsx'], serverModules: [], ...proofOverrides }
  const release = 'bbbbbbb-101-1'
  const files = [
    { name: 'site/index.html', content: `<html><script src="/mikka/assets/main.js?dpl=${release}"></script></html>` },
    { name: 'site/assets/main.js', content: 'export const syntheticFixture = true;' },
    { name: 'site/renderer-actions.json', content: JSON.stringify(actionsOverride ?? rendererActionContract({ ...proof, target: 'web' })) },
    { name: 'proof/renderer-manifest.json', content: JSON.stringify(proof) }, ...extra,
  ]
  const result = JSON.parse(execFileSync('python3', ['-c', String.raw`
import base64,hashlib,io,json,sys,tarfile,zipfile
data=json.load(sys.stdin); tar_bytes=io.BytesIO()
with tarfile.open(fileobj=tar_bytes,mode='w:gz') as tar:
 for file in data['files']:
  info=tarfile.TarInfo(file['name']); content=file.get('content','').encode()
  if file.get('type')=='symlink': info.type=tarfile.SYMTYPE;info.linkname='../../outside'
  else: info.size=len(content)
  tar.addfile(info,io.BytesIO(content))
body=tar_bytes.getvalue(); digest='sha256:'+hashlib.sha256(body).hexdigest()
receipt={'service':'web','kind':'worker','contextDigest':'sha256:'+'e'*64,'sourceCommit':data['source'],'overlayCommit':data['overlay'],'release':data['release'],'reused':False,
 'build':{'runId':'101','runAttempt':'1','workflow':'cloudflare-api-image.yml'},'artifacts':{'assets':{'path':'web.tar.gz','digest':digest}}}
output=io.BytesIO()
with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as bundle:
 bundle.writestr('service-receipt.json',json.dumps(receipt));bundle.writestr('web.tar.gz',body)
print(json.dumps({'archive':base64.b64encode(output.getvalue()).decode(),'web':receipt}))
`], { input: JSON.stringify({ files, source: webSource, overlay, release }), encoding: 'utf8' }))
  return { source, run, manifestArtifact: { id: 303 }, archive: Buffer.from(result.archive, 'base64'),
    web: { ...result.web, reused: true, build: { ...result.web.build, artifactId: '202' } } }
}

async function output(t) {
  const root = await mkdtemp(join(tmpdir(), 'nightly-ui-contract-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return join(root, 'renderer')
}

test('restores actual archive bytes and reports reused UI source separately from tested main', async t => {
  const directory = await output(t)
  const result = await restoreNightlyUi(archive(), directory)
  assert.equal(result.source, source)
  assert.equal(result.webSource, webSource)
  assert.equal(result.reused, true)
  assert.equal(result.overlay, overlay)
  assert.match(await readFile(join(directory, 'index.html'), 'utf8'), /dpl=bbbbbbb-101-1/)
  assert.equal(JSON.parse(await readFile(join(directory, 'renderer-manifest.json'), 'utf8')).target, 'web')
})

test('unsafe paths, links and duplicate tar members never replace an existing renderer', async t => {
  const directory = await output(t)
  await restoreNightlyUi(archive(), directory)
  await writeFile(join(directory, 'sentinel'), 'previous valid renderer')
  for (const entry of [
    { name: 'site/../escaped', content: 'bad' },
    { name: '/absolute', content: 'bad' },
    { name: 'site/link', type: 'symlink' },
    { name: 'site/index.html', content: 'duplicate' },
  ]) {
    await assert.rejects(restoreNightlyUi(archive([entry]), directory))
    assert.equal(await readFile(join(directory, 'sentinel'), 'utf8'), 'previous valid renderer')
  }
})

test('nonofficial renderers, source files, mismatched member digests and changed action contracts are rejected', async t => {
  const directory = await output(t)
  for (const packet of [
    archive([], { inputs: ['components/slots/synthetic.tsx'] }),
    archive([], { target: 'desktop' }),
    archive([{ name: 'site/component.tsx', content: 'synthetic raw source' }]),
    archive([], {}, { version: 1, target: 'web', rendererBuild: 'f'.repeat(64), usedActions: ['tasks.read'], modules: { tasks: ['read'] } }),
  ]) await assert.rejects(restoreNightlyUi(packet, directory))
  const mismatch = archive()
  mismatch.web.artifacts.assets.digest = 'sha256:' + '0'.repeat(64)
  await assert.rejects(restoreNightlyUi(mismatch, directory))
})

test('missing exact-source producer cannot fall back to another successful main run', async () => {
  await assert.rejects(selectNightlyUi({ source, api: async () => ({ total_count: 1, workflow_runs: [{ ...run, head_sha: webSource }] }) }), /exact_producer_unavailable/)
})

test('producer identity and the actual manifest job must pass before any artifact is read', async () => {
  for (const changed of [{ ...run, head_sha: webSource }, { ...run, actor: { id: 1 } }, { ...run, conclusion: 'cancelled' }]) {
    let calls = 0
    await assert.rejects(selectNightlyUi({ source, api: async () => ++calls === 1 ? { total_count: 1, workflow_runs: [run] } : changed }))
    assert.equal(calls, 2)
  }
  let calls = 0
  await assert.rejects(selectNightlyUi({ source, api: async () => {
    calls++
    if (calls === 1) return { total_count: 1, workflow_runs: [run] }
    if (calls === 2) return run
    return { total_count: 1, jobs: [{ name: 'release-manifest', run_id: run.id, run_attempt: run.run_attempt,
      head_sha: source, status: 'completed', conclusion: 'skipped', steps: [] }] }
  } }))
  assert.equal(calls, 3)
})
