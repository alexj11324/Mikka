import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// A read-only, exact-artifact transport for the short, isolated SQL diagnostic.
// The Actions token is confined to this process; signed redirect URLs stay in RAM.
const expected = {
  repository: 'alexj11324/Mikka', repositoryId: 1427517699,
  run: 42357032863, attempt: 1, artifact: 13568227157,
  candidate: '0d33e1bd7b170abe7cb0b8c9d1fef42bc951c920',
  source: '3ad0fe25438887fe04f6dc6bda140f35d0bf4a03',
  tree: 'afe77de97310d38eb230d3ff0ee91f639ca5b8d1',
  digest: 'd40b0a33843af21cd60d9ee9fe2bd049b40dead647a3f077d8d1e048ca6c130c',
  bytes: 47856394,
}
const source = resolve(process.argv[2] ?? '')
const output = resolve(process.argv[3] ?? '')
const temporary = process.env.RUNNER_TEMP
let phase = 'arguments'
let zipPath, tarPath
let verified = false
try {
  assert.equal(process.argv.length, 4)
  assert.ok(temporary && process.env.GH_TOKEN)
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  assert.equal(git('rev-parse', 'HEAD'), expected.source)
  assert.equal(git('rev-parse', 'HEAD^{tree}'), expected.tree)
  const api = `https://api.github.com/repos/${expected.repository}`
  const headers = { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }
  const get = async path => {
    const response = await fetch(api + path, { headers, redirect: 'error', signal: AbortSignal.timeout(30_000) })
    assert.equal(response.status, 200)
    return response.json()
  }
  phase = 'provenance'
  const [run, artifact, commit] = await Promise.all([
    get(`/actions/runs/${expected.run}`), get(`/actions/artifacts/${expected.artifact}`), get(`/git/commits/${expected.source}`),
  ])
  assert.equal(run.repository.id, expected.repositoryId)
  assert.equal(run.event, 'pull_request')
  assert.equal(run.run_attempt, expected.attempt)
  assert.equal(run.status, 'completed')
  assert.equal(run.conclusion, 'success')
  assert.equal(run.head_sha, expected.candidate)
  assert.equal(artifact.name, `desktop-api-build-${expected.source}`)
  assert.equal(artifact.workflow_run.id, expected.run)
  assert.equal(artifact.workflow_run.head_sha, expected.candidate)
  assert.equal(artifact.workflow_run.repository_id, expected.repositoryId)
  assert.equal(artifact.expired, false)
  assert.equal(artifact.digest, `sha256:${expected.digest}`)
  assert.equal(artifact.size_in_bytes, expected.bytes)
  assert.equal(commit.tree.sha, expected.tree)
  assert.deepEqual(commit.parents.map(parent => parent.sha), ['f811448d805e7baa7b032fd6ae62d991f59966c8', expected.candidate])
  phase = 'download'
  const redirect = await fetch(`${api}/actions/artifacts/${expected.artifact}/zip`, { headers, redirect: 'manual', signal: AbortSignal.timeout(30_000) })
  assert.equal(redirect.status, 302)
  const location = new URL(redirect.headers.get('location'))
  assert.equal(location.protocol, 'https:')
  assert.equal(location.username + location.password, '')
  await redirect.body?.cancel()
  // Never forward the GitHub token to the artifact object's host.
  const response = await fetch(location, { redirect: 'error', signal: AbortSignal.timeout(90_000) })
  assert.equal(response.status, 200)
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.equal(bytes.byteLength, expected.bytes)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.digest)
  zipPath = join(temporary, 'desktop-api-build.zip')
  tarPath = join(temporary, 'desktop-api-build.tar.gz')
  await writeFile(zipPath, bytes, { mode: 0o600, flag: 'wx' })
  phase = 'extract'
  execFileSync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.namelist()==["desktop-api-build.tar.gz"]; b=z.read("desktop-api-build.tar.gz"); assert len(b)<128*1024*1024; f=open(sys.argv[2],"xb"); f.write(b); f.close()', zipPath, tarPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  execFileSync('tar', ['-xzf', tarPath, '-C', source], { stdio: ['ignore', 'pipe', 'pipe'] })
  const archive = await readFile(tarPath)
  await mkdir(output, { recursive: true, mode: 0o700 })
  const receipt = { version: 1, status: 'verified', ...expected, artifactKind: 'linux_compiled_api',
    tarBytes: archive.byteLength, tarSha256: createHash('sha256').update(archive).digest('hex'),
    artifactCreatedAt: artifact.created_at, workflowCreatedAt: run.created_at,
    recordedAt: new Date().toISOString(), currentAttempt: true,
    sameProductTreeAsCandidate: true, productionAcceptance: false,
    signedUrlPersisted: false, credentialPersisted: false }
  await writeFile(join(output, 'artifact-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
  verified = true
  console.log(JSON.stringify({ artifactVerified: true, artifactId: expected.artifact, source: expected.source, tree: expected.tree }))
} catch (error) {
  const name = ['AssertionError', 'TypeError', 'TimeoutError', 'SyntaxError', 'Error'].includes(error?.name) ? error.name : 'other'
  console.error(JSON.stringify({ artifactVerified: false, phase, code: 'SOURCE_ARTIFACT_CHECK_FAILED', cause: { name, ...(error?.code === 'ERR_ASSERTION' ? { code: error.code } : {}) } }))
  process.exitCode = 1
} finally {
  // The diagnostic independently verifies the same ZIP; the workflow's always
  // step removes it afterward. Failed downloads and the extracted tar never remain.
  await Promise.allSettled([verified ? null : zipPath, tarPath].filter(Boolean).map(path => rm(path, { force: true })))
}
