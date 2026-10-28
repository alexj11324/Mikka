// Plain Node child: imports only the freshly npm-installed distributable.
// MemoryServer and the mock model are explicit substitutes; git operations,
// clone/worktree creation, verification, commit and local-bare push are real.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [installed, temporary] = process.argv.slice(2)
assert.ok(installed && temporary)
assert.equal(process.env.NODE_OPTIONS, undefined)
assert.equal(process.env.NODE_PATH, undefined)
assert.equal(process.env.NODE_ENV, 'test')
assert.equal(process.env.MIKKA_TEST_MODE, '1')
const { Daemon, MemoryServer } = await import(pathToFileURL(join(installed, 'main.js')).href)
const personal = join(temporary, 'personal-checkout'), bare = join(temporary, 'origin.git')
await mkdir(personal)
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=Mikka Package Test', '-c', 'user.email=package@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
git(personal, 'init', '-q', '-b', 'trunk')
await writeFile(join(personal, 'README.md'), '# Disposable packaged-daemon fixture\n')
git(personal, 'add', '.')
git(personal, 'commit', '-q', '-m', 'fixture')
git(personal, 'clone', '--bare', '--no-hardlinks', personal, bare)
await writeFile(join(personal, 'README.md'), 'Uncommitted personal work must stay unchanged.\n')
const before = git(personal, 'status', '--porcelain')
const server = new MemoryServer('package-device')
const daemon = new Daemon({
  dataDir: join(temporary, 'data'), flavor: 'dev', link: server.link(),
  harnesses: [{ harness: 'mock', installed: true, version: 'package-test' }],
  mockSpeed: Infinity, heartbeatMs: 25, commandsWaitSeconds: 1,
  quotaSource: null, agentSandbox: null,
})
const waitFor = async check => {
  const deadline = Date.now() + 20_000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('PACKAGED_DAEMON_TASK_TIMEOUT')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
try {
  await daemon.start()
  await daemon.syncWithServer()
  const runId = server.queueRun('package-device', {
    issueId: 'package-issue', repoId: 'package-record-only', remoteUrl: pathToFileURL(bare).href,
    harness: 'mock', prompt: 'Add the mock usage note', fixture: 'success-edit',
    verifyCommand: 'git diff --check', pushBranch: 'mikka/package-1',
    policy: { permissions: { install_dependency: 'deny', write_outside_repo: 'deny', git_push: 'allow', network: 'deny' }, networkAllow: [] },
  })
  await daemon.syncWithServer()
  await waitFor(() => daemon.supervisor.list().some(run => run.runId === runId))
  await daemon.supervisor.idle()
  await waitFor(() => server.runs.get(runId)?.completion && daemon.status().pendingUploads === 0)
  assert.equal(daemon.supervisor.get(runId).state, 'succeeded')
  const report = server.runs.get(runId).completion.report
  assert.equal(report.verify.status, 'passed')
  assert.equal(report.publish.pushed, true)
  assert.equal(report.publish.branch, 'mikka/package-1')
  assert.match(report.publish.commit, /^[a-f0-9]{40}$/)
  assert.equal(git(bare, 'rev-parse', 'refs/heads/mikka/package-1'), report.publish.commit)
  assert.match(git(bare, 'show', 'refs/heads/mikka/package-1:MIKKA_MOCK.md'), /Written by the Mikka mock harness/)
  assert.equal(server.repos.size, 0)
  assert.equal(git(personal, 'status', '--porcelain'), before)
  assert.equal(git(personal, 'worktree', 'list').split('\n').length, 1)
  assert.equal(git(personal, 'branch', '--list', 'mikka/*'), '')
  assert.equal(await readFile(join(personal, 'README.md'), 'utf8'), 'Uncommitted personal work must stay unchanged.\n')
  console.log('PACKAGED_MOCK_DAEMON_GIT_TASK_PASSED')
} finally {
  await daemon.stop()
}
