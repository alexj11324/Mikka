import { execFileSync } from 'node:child_process'
import { appendFile, lstat, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { publishEvidenceRef } from './verify-created-ref.mjs'
import { githubEvidenceFailure } from './github-error.mjs'

// Only a same-repository PR can publish. There is no update-ref, delete, force
// push, source-branch write, external credential or artifact-storage fallback.
const env = process.env
if (env.GITHUB_ACTIONS !== 'true' || env.CI !== 'true' || env.GITHUB_EVENT_NAME !== 'pull_request'
  || !env.GITHUB_TOKEN || !env.GITHUB_EVENT_PATH || !env.GITHUB_STEP_SUMMARY
  || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? '')
  || !/^\d+$/.test(env.GITHUB_RUN_ID ?? '') || !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? '')) throw new Error('EVIDENCE_REQUIRES_SAME_REPOSITORY_PR')
const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'))
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
if (!/^[a-f0-9]{40}$/.test(head) || event.pull_request?.head?.sha !== head
  || event.pull_request.head.repo?.full_name !== env.GITHUB_REPOSITORY
  || event.repository?.full_name !== env.GITHUB_REPOSITORY) throw new Error('EVIDENCE_SOURCE_MISMATCH')
const directory = resolve('.artifacts/self-hosting-ui/evidence')
const manifest = JSON.parse(await readFile(resolve(directory, 'evidence.json'), 'utf8'))
const build = JSON.parse(await readFile(resolve(directory, 'build.json'), 'utf8'))
if (manifest.commit !== head || build.commit !== head || manifest.run !== env.GITHUB_RUN_ID
  || manifest.synthetic !== true || manifest.reviewed !== false || manifest.oauthAccepted !== false
  || manifest.runtimeAccepted !== false || !Array.isArray(manifest.evidence) || !manifest.evidence.length) throw new Error('EVIDENCE_MANIFEST_INVALID')
const pictures = manifest.evidence.map(item => item.file)
if (new Set(pictures).size !== pictures.length || pictures.some(file => typeof file !== 'string'
  || !/^synthetic-(?:zh-CN|en)-(?:light|dark)-[a-z0-9-]+\.png$/.test(file))) throw new Error('EVIDENCE_PICTURE_PATH_INVALID')
const branch = `evidence/self-hosting-ui/${head}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`
const repositoryUrl = `https://github.com/${env.GITHUB_REPOSITORY}`
const runUrl = `${repositoryUrl}/actions/runs/${env.GITHUB_RUN_ID}`
await writeFile(resolve(directory, 'README.md'), `# Self-hosting UI visual evidence\n\n**Synthetic GET records · visual evidence only · not yet reviewed.**\n\nSource: [${head}](${repositoryUrl}/commit/${head}) · [CI run](${runUrl})\n\nExisting production Web components and actual Expo Web export. No real account, OAuth, billing, save, discovery, push or native iOS acceptance.\n\n[Gallery](index.html) (download with the PNGs for the grid) · [Capture manifest](evidence.json) · [Build manifest](build.json)\n\n${pictures.map(file => `## ${file}\n\n![${file}](${file})\n`).join('\n')}`)
const files = ['README.md', 'index.html', 'build.json', 'evidence.json', ...pictures]
const contents = []
for (const file of files) {
  const path = resolve(directory, file), info = await lstat(path)
  if (!info.isFile() || info.size === 0 || info.size > 10 * 1024 * 1024) throw new Error('EVIDENCE_FILE_INVALID')
  const bytes = await readFile(path)
  if (file.endsWith('.png') && !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('EVIDENCE_PNG_INVALID')
  contents.push({ file, bytes })
}
async function api(path, body) {
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/git${path}`, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30_000),
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (response.status !== (body === undefined ? 200 : 201)) {
    const body = await response.json().catch(() => null)
    const cause = { endpoint: path, requestId: response.headers.get('x-github-request-id'), ...githubEvidenceFailure(body, response.headers) }
    if (path === '/refs' && [409, 422].includes(response.status) && cause.category === 'reference_exists') {
      throw new Error('EVIDENCE_BRANCH_ALREADY_EXISTS', { cause })
    }
    throw new Error(`EVIDENCE_GITHUB_HTTP_${response.status}`, { cause })
  }
  return response.json()
}
const entries = []
for (const { file, bytes } of contents) {
  const blob = await api('/blobs', { content: bytes.toString('base64'), encoding: 'base64' })
  entries.push({ path: file, mode: '100644', type: 'blob', sha: blob.sha })
}
// A new root commit contains evidence only. It cannot carry the product code or
// workflow files. POST /refs creates a ref and refuses an existing name.
const tree = await api('/trees', { tree: entries })
const commit = await api('/commits', { message: `Synthetic self-hosting UI evidence for ${head}, run ${env.GITHUB_RUN_ID} [skip ci]`, tree: tree.sha, parents: [] })
await publishEvidenceRef(api, branch, commit.sha)
const fixedUrl = `${repositoryUrl}/tree/${commit.sha}`
await appendFile(env.GITHUB_STEP_SUMMARY, `## Self-hosting UI evidence\n\n**Synthetic records · visual only · awaiting review.**\n\n${pictures.length} PNGs from source \`${head}\`.\n\n- [Evidence branch](${repositoryUrl}/tree/${branch})\n- [Immutable evidence commit and image gallery](${fixedUrl})\n- [HTML gallery](${repositoryUrl}/blob/${commit.sha}/index.html)\n- [Capture manifest](${repositoryUrl}/blob/${commit.sha}/evidence.json)\n\nNo OAuth, billing, discovery, push or native iOS acceptance is claimed.\n`)
console.log(`Created ${branch} at ${commit.sha}; source ${head}; ${pictures.length} synthetic screenshots.`)
