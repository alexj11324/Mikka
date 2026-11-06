import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { processTree, stopTree } from './owned-process-tree.mjs'
import { cacheDirectory } from './runtime-performance.mjs'

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'mikka-performance-cache-'))
  const outside = await mkdtemp(join(tmpdir(), 'mikka-performance-outside-'))
  try {
    execFileSync('git', ['init', '--quiet', root])
    await writeFile(join(root, '.gitignore'), '/.next/\n/.cache/dev-runtime/\n')
    await run(root, outside)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
}

test('cold compiler cache directories are recognized while still absent', () => fixture(async root => {
  for (const path of ['.next', '.cache/dev-runtime/3111']) {
    assert.equal(await cacheDirectory(root, path), join(root, path))
    await assert.rejects(readFile(join(root, path)), { code: 'ENOENT' })
  }
}))

test('tracked cache content is refused even under an ignore rule', () => fixture(async root => {
  await mkdir(join(root, '.next'))
  await writeFile(join(root, '.next', 'kept'), 'tracked evidence')
  execFileSync('git', ['add', '-f', '.next/kept'], { cwd: root })
  await assert.rejects(cacheDirectory(root, '.next'), /tracked files/)
  assert.equal(await readFile(join(root, '.next', 'kept'), 'utf8'), 'tracked evidence')
}))

test('unignored directories and symlinks outside the snapshot are refused', () => fixture(async (root, outside) => {
  await mkdir(join(root, 'unignored'))
  await assert.rejects(cacheDirectory(root, 'unignored'))
  await symlink(outside, join(root, '.next'), 'dir')
  await assert.rejects(cacheDirectory(root, '.next'), /another checkout/)
}))


test('detached double-fork descendants stay in measured ownership and are stopped without touching other processes', { skip: process.platform !== 'linux', timeout: 45000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'owned-descendant-probe-'))
  const receipt = join(root, 'receipt.json'), childFile = join(root, 'grandchild.pid')
  const program = [
    'import os,sys,time', 'if os.fork()==0:', ' os.setsid()', ' if os.fork()==0:',
    '  payload=bytearray(24*1024*1024)',
    "  with open(sys.argv[1],'w') as f:f.write(str(os.getpid()))",
    '  while True:time.sleep(1)', ' os._exit(0)', "print('READY',flush=True)", 'while True:time.sleep(1)'
  ].join('\n')
  const foreign = spawn('python3', ['-c', 'import time; time.sleep(60)'], { stdio: 'ignore' })
  const foreignExit = once(foreign, 'exit')
  const app = spawn('python3', [fileURLToPath(new URL('./owned-process-supervisor.py', import.meta.url)), receipt, 'python3', '-c', program, childFile], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''; app.stderr.on('data', b => { stderr += b })
  let closed = false
  try {
    const limit = performance.now() + 8000
    let pid, rows
    while (performance.now() < limit) {
      try { pid = Number(await readFile(childFile, 'utf8')) } catch {}
      rows = await processTree(app.pid)
      if (pid && rows.some(row => row.pid === pid)) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.ok(pid && rows.some(row => row.pid === pid), stderr)
    const escaped = rows.find(row => row.pid === pid)
    assert.equal(escaped.ppid, app.pid, 'double-fork orphan is adopted by the dedicated subreaper')
    assert.notEqual(escaped.sid, app.pid, 'the actual child escaped the original session')
    assert.notEqual(escaped.pgid, app.pid, 'the old process-group sampler would omit it')
    assert.ok(escaped.rssBytes >= 24 * 1024 * 1024)
    assert.ok(!rows.some(row => row.pid === foreign.pid), 'unrelated process is excluded')
    const leader = rows.find(row => row.pid === app.pid)
    const result = await stopTree(app, leader.startTicks, receipt)
    assert.equal(result.stopped, true); assert.equal(result.forced, false)
    assert.ok(result.detachedDescendants >= 1); assert.equal(result.remainingDescendants, 0)
    process.kill(foreign.pid, 0)
    closed = true
    assert.equal(result.subreaper, true)
  } finally {
    if (!closed) { try { await stopTree(app, undefined, receipt) } catch {} }
    foreign.kill('SIGTERM'); await foreignExit.catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})
