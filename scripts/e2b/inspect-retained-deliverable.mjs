/** Read an existing completed delivery. This never applies a checkpoint, creates
 * a commit, changes a ref/index, or starts a model. The old checkpoint is only
 * an integrity witness for the live, still-retained committed tree. */
export async function inspectRetainedDeliverable(input, roots = {
  botWorkspaces: '/home/user/.mikka/bot-workspaces', worker: '/home/user/.mikka/worker',
}) {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { createHash } = await import('node:crypto')
  const { execFileSync } = await import('node:child_process')
  const fail = code => { throw new Error(`retained_delivery_${code}`) }
  const sha = value => createHash('sha256').update(value).digest('hex')
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  const commit = /^[0-9a-f]{40}$/
  const directChild = (value, root) => typeof value === 'string' && path.dirname(value) === root && uuid.test(path.basename(value))
  if (!input || !uuid.test(input.producerRunId) || !uuid.test(input.deviceId) || !uuid.test(input.deviceRepoId) || !uuid.test(input.issueId) ||
      typeof input.producerSessionId !== 'string' || !input.producerSessionId || input.producerSessionId.length > 1000 || !commit.test(input.sourceCommit) ||
      !directChild(input.repoPath, roots.botWorkspaces) || !directChild(input.worktreePath, path.join(roots.worker, 'worktrees')) ||
      !/^[0-9a-f]{64}$/.test(input.checkpoint?.patchSha256) || !Number.isSafeInteger(input.checkpoint?.patchBytes) ||
      input.checkpoint.patchBytes < 1 || input.checkpoint.patchBytes > 16 * 1024 * 1024 ||
      !Number.isSafeInteger(input.checkpoint?.files) || input.checkpoint.files < 1) fail('scope_mismatch')
  const exactDirectory = value => {
    try { return fs.lstatSync(value).isDirectory() && fs.realpathSync(value) === value } catch { return false }
  }
  if (!exactDirectory(input.repoPath) || !exactDirectory(input.worktreePath) || !exactDirectory(roots.worker)) fail('path_mismatch')
  const journalPath = path.join(roots.worker, 'runs.json')
  const readBounded = (file, limit) => {
    let fd
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || stat.size > limit) fail('path_mismatch')
      const bytes = fs.readFileSync(fd)
      if (bytes.length !== stat.size || fs.fstatSync(fd).mtimeMs !== stat.mtimeMs) fail('changed')
      return bytes
    } finally { if (fd !== undefined) fs.closeSync(fd) }
  }
  let journalBytes, entries, entry
  try {
    journalBytes = readBounded(journalPath, 32 * 1024 * 1024)
    entries = JSON.parse(journalBytes.toString('utf8')).runs
    entry = entries?.[input.producerRunId]
  } catch { fail('journal_unavailable') }
  const assignment = entry?.assignment
  if (entry?.state !== 'succeeded' || entry?.stopReason !== 'submitted' || entry.sessionId !== input.producerSessionId ||
      entry.worktree !== input.worktreePath || entry.baseCommit !== input.sourceCommit || !Number.isFinite(Date.parse(entry.updatedAt)) ||
      assignment?.runId !== input.producerRunId || assignment.deviceId !== input.deviceId || assignment.issueId !== input.issueId ||
      assignment.repoId !== input.deviceRepoId) fail('journal_mismatch')
  const terminal = new Set(['succeeded', 'failed', 'stopped', 'cancelled'])
  if (Object.values(entries).some(value => !terminal.has(value?.state))) fail('active_run')
  const common = path.join(input.repoPath, '.git'), worktrees = path.join(common, 'worktrees')
  if (!exactDirectory(common) || !exactDirectory(worktrees)) fail('path_mismatch')
  let gitDir
  for (const name of fs.readdirSync(worktrees)) {
    const candidate = path.join(worktrees, name)
    if (!exactDirectory(candidate)) continue
    try {
      if (readBounded(path.join(candidate, 'gitdir'), 4096).toString('utf8').trim() === path.join(input.worktreePath, '.git')) {
        if (gitDir) fail('path_mismatch')
        gitDir = candidate
      }
    } catch { fail('path_mismatch') }
  }
  if (!gitDir) fail('path_mismatch')
  const dotGit = readBounded(path.join(input.worktreePath, '.git'), 4096).toString('utf8').trim()
  if (dotGit !== `gitdir: ${gitDir}`) fail('path_mismatch')
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_DIR: gitDir, GIT_COMMON_DIR: common, GIT_WORK_TREE: input.worktreePath }
  const git = (args, emptyIfNoMatch = false) => {
    try {
      return execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
        '-c', 'commit.gpgSign=false', '-c', 'protocol.ext.allow=never', ...args],
      { cwd: input.worktreePath, env, timeout: 6000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      if (emptyIfNoMatch && error?.status === 1) return Buffer.alloc(0)
      fail('git_unavailable')
    }
  }
  // Even status can invoke a configured clean/process filter when it checks
  // tracked bytes. Read names only and refuse before any such Git operation.
  if (git(['config', '--includes', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$'], true).length) fail('git_filter')
  // These flags can make status hide changed tracked bytes. Reject them without
  // clearing flags or refreshing the producer's historical index.
  if (git(['ls-files', '-v', '-z']).toString('utf8').split('\0').some(record => /^[a-zS] /.test(record))) fail('index_flags')
  if (git(['status', '--porcelain', '--untracked-files=all']).length) fail('dirty')
  const head = git(['rev-parse', 'HEAD']).toString('utf8').trim()
  const tree = git(['rev-parse', 'HEAD^{tree}']).toString('utf8').trim()
  if (!commit.test(head) || !commit.test(tree)) fail('git_unavailable')
  git(['merge-base', '--is-ancestor', input.sourceCommit, head])
  const diff = git(['diff', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', input.sourceCommit, head])
  const names = git(['diff', '--name-only', '-z', input.sourceCommit, head]).toString('utf8').split('\0').filter(Boolean)
  if (diff.length !== input.checkpoint.patchBytes || sha(diff) !== input.checkpoint.patchSha256 || names.length !== input.checkpoint.files) fail('checkpoint_mismatch')
  if (git(['status', '--porcelain', '--untracked-files=all']).length || git(['rev-parse', 'HEAD']).toString('utf8').trim() !== head ||
      sha(readBounded(journalPath, 32 * 1024 * 1024)) !== sha(journalBytes)) fail('changed')
  return { head, tree, diffSha256: sha(diff), diffBytes: diff.length, clean: true, observedAt: new Date().toISOString(),
    journalUpdatedAt: entry.updatedAt, producerRunId: input.producerRunId, sessionId: input.producerSessionId, worktreePath: input.worktreePath }
}

if (process.argv[1] === '--mikka-retained-delivery-probe') {
  try {
    const input = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'))
    process.stdout.write(JSON.stringify({ ok: true, value: await inspectRetainedDeliverable(input) }))
  } catch (error) {
    const codes = new Set(['scope_mismatch', 'path_mismatch', 'journal_unavailable', 'journal_mismatch', 'active_run', 'git_unavailable', 'git_filter',
      'dirty', 'index_flags', 'checkpoint_mismatch', 'changed'].map(code => `retained_delivery_${code}`))
    process.stdout.write(JSON.stringify({ ok: false, code: codes.has(error?.message) ? error.message : 'retained_delivery_probe_failed' }))
  }
}
