/** Checked-in commands sent only to this case's normal owner PTY. No remote
 * host, provider key, arbitrary command, clone, push-to-default or PR merge.
 */
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const SHA = /^[a-f0-9]{40}$/
const DIGEST = /^[a-f0-9]{64}$/
const NODE = '/opt/mikka/runtime/node/bin/node'
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
const check = condition => { if (!condition) throw Error('workspace_review_native_scope') }

export function runtimeAssertionScript({ workerSha, workerSourceCommit }) {
  check(SHA.test(workerSha ?? '') && SHA.test(workerSourceCommit ?? ''))
  const script = `const f=require('node:fs'),p='/opt/mikka/worker-source-sha',s=f.lstatSync(p);if(!s.isFile()||s.uid!==0||(s.mode&0o222)!==0||f.readFileSync(p,'utf8').trim()!==${JSON.stringify(workerSha)}||f.realpathSync('/opt/mikka/worker')!==${JSON.stringify(`/opt/mikka/releases/${workerSourceCommit}/source`)})process.exit(1)`
  return `${NODE} -e ${quote(script)}`
}

/** Self-contained for serialization into the native PTY; injectable subprocess
 * execution exists only for local deterministic scope/cleanup regression tests.
 * All provider responses and native credential-backed output stay in memory.
 */
export async function cleanupNativePublication(config, dependencies = {}) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { createHash } = await import('node:crypto')
  const execute = dependencies.execute ?? promisify(execFile), now = dependencies.now ?? Date.now
  const repository = 'alexj11324/Mikka-handoff', remote = `https://github.com/${repository}.git`
  const valid = condition => { if (!condition) throw Error('workspace_review_publication_unconfirmed') }
  const sha = value => /^[a-f0-9]{40}$/.test(value ?? '')
  const hash = value => createHash('sha256').update(value).digest('hex')
  valid(config.repository === repository && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(config.issueId ?? '')
    && /^mikka\/[a-z0-9][a-z0-9-]{0,100}$/.test(config.branch ?? '') && sha(config.candidateSha) && sha(config.baseCommit)
    && Number.isSafeInteger(config.prNumber) && config.prNumber > 0
    && /^docs\/coding-workspace\/acceptance-[a-f0-9-]{36}\.txt$/.test(config.filePath ?? '')
    && /^[a-f0-9]{64}$/.test(config.fileSha256 ?? '') && Number.isSafeInteger(config.createdAfter)
    && config.createdAfter > 0 && config.createdAfter < now())
  const deadline = now() + 60000
  const command = async (program, args) => {
    const remaining = deadline - now(); valid(remaining > 0)
    // The PTY has a clean environment. Reuse the same ordinary, non-secret gh
    // credential helper as MACHINE_GITHUB_ENV; never copy or print its token.
    const nativeArgs = program === 'git' ? ['-c', 'credential.helper=', '-c',
      'credential.https://github.com.helper=!gh auth git-credential', '-c', 'credential.useHttpPath=true', ...args] : args
    const result = await execute(program, nativeArgs, { encoding: 'utf8', timeout: Math.min(15000, remaining), maxBuffer: 1024 * 1024 })
    return result.stdout.trim()
  }
  const gh = async path => JSON.parse(await command('gh', ['api', path]))
  const head = async branch => {
    const value = await command('git', ['ls-remote', remote, `refs/heads/${branch}`])
    if (!value) return ''
    const rows = value.split('\n'); valid(rows.length === 1)
    const [commit, ref, extra] = rows[0].split(/\s+/)
    valid(sha(commit) && ref === `refs/heads/${branch}` && extra === undefined); return commit
  }
  const repo = await gh(`repos/${repository}`), base = repo.default_branch
  valid(repo.full_name === repository && repo.permissions?.push === true && typeof base === 'string'
    && /^[A-Za-z0-9._/-]{1,200}$/.test(base) && !base.includes('..') && base !== config.branch)
  const initialBase = await head(base); valid(sha(initialBase))
  valid(await head(config.branch) === config.candidateSha)
  valid(await command('git', ['rev-parse', 'HEAD']) === config.candidateSha)
  const first = await gh(`repos/${repository}/pulls/${config.prNumber}`), actor = first.user?.id
  const bound = pr => pr?.number === config.prNumber && pr.head?.ref === config.branch && pr.head.sha === config.candidateSha
    && pr.head.repo?.full_name === repository && pr.base?.repo?.full_name === repository && pr.base.ref === base
    && pr.user?.id === actor && Number.isSafeInteger(actor) && actor > 0 && !pr.merged && !pr.merged_at
    && typeof pr.body === 'string' && pr.body.trimEnd().endsWith(`<!-- mikka-issue:${config.issueId} -->`)
    && Date.parse(pr.created_at) >= config.createdAfter - 60000 && Date.parse(pr.created_at) <= now() + 60000
  valid(bound(first) && first.state === 'open')
  const file = await gh(`repos/${repository}/contents/${config.filePath}?ref=${config.candidateSha}`)
  valid(file.type === 'file' && file.path === config.filePath && file.encoding === 'base64'
    && hash(Buffer.from(file.content, 'base64')) === config.fileSha256)
  const changes = await gh(`repos/${repository}/compare/${config.baseCommit}...${config.candidateSha}`)
  valid(changes.status === 'ahead' && changes.merge_base_commit?.sha === config.baseCommit && changes.files?.length === 1
    && changes.files[0].filename === config.filePath && changes.files[0].status === 'added')
  // Recheck the author/head just before closing; a changed remote is retained.
  valid(bound(await gh(`repos/${repository}/pulls/${config.prNumber}`)))
  valid(await head(config.branch) === config.candidateSha)
  await command('gh', ['pr', 'close', String(config.prNumber), '--repo', repository])
  const closed = await gh(`repos/${repository}/pulls/${config.prNumber}`)
  valid(bound(closed) && closed.state === 'closed')
  valid(await head(config.branch) === config.candidateSha)
  // Ordinary ref deletion, with no force, rebase, default-branch write or merge.
  await command('git', ['push', remote, `:refs/heads/${config.branch}`])
  valid(await head(config.branch) === '')
  valid(await head(base) === initialBase)
  return { status: 'passed', prNumber: config.prNumber, candidateSha: config.candidateSha,
    prClosed: true, branchDeleted: true, defaultBranchUnchanged: true }
}

export function ownedPublicationCleanupScript(config) {
  check(config?.repository === 'alexj11324/Mikka-handoff' && UUID.test(config.issueId ?? '')
    && SHA.test(config.candidateSha ?? '') && SHA.test(config.baseCommit ?? '')
    && DIGEST.test(config.fileSha256 ?? '') && /^mikka\/[a-z0-9][a-z0-9-]{0,100}$/.test(config.branch ?? '')
    && Number.isSafeInteger(config.prNumber) && config.prNumber > 0 && Number.isSafeInteger(config.createdAfter)
    && /^docs\/coding-workspace\/acceptance-[a-f0-9-]{36}\.txt$/.test(config.filePath ?? ''))
  const script = `(${cleanupNativePublication.toString()})(${JSON.stringify(config)}).catch(()=>{process.exitCode=1})`
  const command = `${NODE} -e ${quote(script)}`
  check(Buffer.byteLength(command) <= 14000)
  return command
}
