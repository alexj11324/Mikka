import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fstatSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { hostedBinaries } from '../src/hosted-binaries'
import { prefetchHostedCliFiles } from '../src/hosted-cli-prefetch'
import { cleanupTempDirs, tempDir } from './helpers'

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
beforeEach(() => { vi.mocked(fs.open).mockReset().mockImplementation(actualFs.open) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); cleanupTempDirs() })
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
const write = (file: string, body: string | Buffer) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, body, { mode: 0o755 })
  return file
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
function installation(optional = true) {
  const root = realpathSync(tempDir()), modules = join(root, 'node_modules')
  const cli = join(modules, '@openai/codex')
  const launcher = write(join(cli, 'bin/codex.js'), '#!/usr/bin/env node\nthrow Error("must not execute")\n')
  write(join(cli, 'package.json'), JSON.stringify({ name: '@openai/codex', bin: { codex: 'bin/codex.js' } }))
  const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const triple = `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-${os === 'linux' ? 'unknown-linux-musl' : os === 'darwin' ? 'apple-darwin' : 'pc-windows-msvc'}`
  const platform = join(modules, `@openai/codex-${os}-${arch}`)
  if (optional) write(join(platform, 'package.json'), JSON.stringify({ name: `@openai/codex-${os}-${arch}` }))
  const native = write(join(optional ? platform : cli, 'vendor', triple, 'bin', os === 'win32' ? 'codex.exe' : 'codex'),
    Buffer.concat([Buffer.from('\x7fELF'), Buffer.alloc(600_013, 37)]))
  const claude = write(join(root, 'claude'), Buffer.alloc(330_019, 79))
  const manifest = join(root, 'manifest.json')
  write(manifest, JSON.stringify({ version: 1, kind: 'desktop', original: {
    claude_code: { path: claude, sha256: hash(claude) }, codex: { path: launcher, sha256: hash(launcher) },
  }, added: {} }))
  return { root, cli, platform, launcher, native, claude, manifest, triple }
}

it.each([true, false])('reads the exact official resolver selection and Codex backend without executing them (optional package: %s)', async optional => {
  const f = installation(optional)
  const before = [f.claude, f.launcher, f.native].map(path => ({ path, sha: hash(path), mode: statSync(path).mode, mtime: statSync(path).mtimeMs }))
  const decoy = write(join(f.root, 'other-codex'), 'not selected')
  const binaries = hostedBinaries(undefined, { manifestPath: f.manifest, path: dirname(decoy) })
  const result = await prefetchHostedCliFiles(binaries).done
  expect(result).toEqual({ status: 'complete', files: 3, bytes: before.reduce((sum, row) => sum + statSync(row.path).size, 0) })
  for (const row of before) {
    expect(hash(row.path)).toBe(row.sha)
    expect(statSync(row.path).mode).toBe(row.mode)
    expect(statSync(row.path).mtimeMs).toBe(row.mtime)
  }
})

it('uses the selected package dependency, not a same-name ambient launcher or the legacy vendor fallback', async () => {
  const f = installation()
  const legacy = write(join(f.cli, 'vendor', f.triple, 'bin/codex'), 'unselected legacy backend')
  const original = actualFs.open
  const opened: string[] = []
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    opened.push(String(args[0]))
    return original(...args)
  })
  const result = await prefetchHostedCliFiles({ codex: f.launcher }, 'codex').done
  expect(result.files).toBe(2)
  expect(opened).toContain(f.native)
  expect(opened).not.toContain(legacy)
  expect(opened).not.toContain(f.claude)
})

it('warms only the template harness and never changes the ordinary environment or HOME', async () => {
  const f = installation(), env = { ...process.env }
  const result = await prefetchHostedCliFiles({ claude_code: f.claude, codex: f.launcher }, 'claude').done
  expect(result).toEqual({ status: 'complete', files: 1, bytes: statSync(f.claude).size })
  expect(process.env).toEqual(env)
})

it('does not follow a platform binary link into another file', async () => {
  const f = installation(), outside = write(join(f.root, 'not-cli-data'), 'not software')
  unlinkSync(f.native); symlinkSync(outside, f.native)
  const opened: string[] = []
  vi.mocked(fs.open).mockImplementation(async (...args) => { opened.push(String(args[0])); return actualFs.open(...args) })
  expect(await prefetchHostedCliFiles({ codex: f.launcher }).done)
    .toEqual({ status: 'partial', files: 1, bytes: statSync(f.launcher).size })
  expect(opened).not.toContain(outside)
  expect(opened).not.toContain(f.native)
})

it.each(['wrong-name', 'oversized'])('does not guess a native backend from %s package metadata', async kind => {
  const f = installation()
  writeFileSync(join(f.cli, 'package.json'), kind === 'wrong-name'
    ? JSON.stringify({ name: 'unrelated-package', bin: { codex: 'bin/codex.js' } }) : ' '.repeat(8193))
  const opened: string[] = []
  vi.mocked(fs.open).mockImplementation(async (...args) => { opened.push(String(args[0])); return actualFs.open(...args) })
  expect(await prefetchHostedCliFiles({ codex: f.launcher }).done)
    .toEqual({ status: 'partial', files: 1, bytes: statSync(f.launcher).size })
  expect(opened).not.toContain(f.native)
})

it('returns immediately, aborts between actual reads, and closes the open descriptor before settling', async () => {
  const f = installation(), entered = deferred(), release = deferred()
  const original = actualFs.open
  const descriptors: number[] = [], readSizes: number[] = []
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await original(...args)
    descriptors.push(handle.fd)
    if (String(args[0]) === f.claude) {
      const read = handle.read.bind(handle)
      vi.spyOn(handle, 'read').mockImplementation(async (...values) => {
        const result = await Reflect.apply(read, handle, values)
        readSizes.push(result.bytesRead)
        entered.resolve()
        await release.promise
        return result
      })
    }
    return handle
  })
  const prefetched = prefetchHostedCliFiles({ claude_code: f.claude, codex: f.launcher })
  let settled = false
  void prefetched.done.then(() => { settled = true })
  try {
    await entered.promise
    expect(settled).toBe(false)
    prefetched.abort(); prefetched.abort()
    expect(settled).toBe(false)
  } finally { release.resolve() }
  expect(await prefetched.done).toMatchObject({ status: 'aborted', files: 0 })
  expect(readSizes).toHaveLength(1)
  expect(readSizes[0]).toBeLessThan(statSync(f.claude).size)
  expect(descriptors).toHaveLength(1)
  for (const fd of descriptors) expect(() => fstatSync(fd)).toThrow()
})

it('does no I/O when cancelled before its first asynchronous open', async () => {
  const f = installation(), opened = vi.mocked(fs.open)
  const job = prefetchHostedCliFiles({ codex: f.launcher })
  job.abort()
  expect(await job.done).toEqual({ status: 'aborted', files: 0, bytes: 0 })
  expect(opened).not.toHaveBeenCalled()
})

it('has a single bounded budget and drains its in-flight read without scheduling another pass', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const f = installation(), entered = deferred(), release = deferred()
  let fd = -1, reads = 0
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const file = await actualFs.open(...args)
    fd = file.fd
    const read = file.read.bind(file)
    vi.spyOn(file, 'read').mockImplementation(async (...values) => {
      const value = await Reflect.apply(read, file, values)
      reads++; entered.resolve(); await release.promise
      return value
    })
    return file
  })
  const job = prefetchHostedCliFiles({ claude_code: f.claude })
  try { await entered.promise; await vi.advanceTimersByTimeAsync(10_000) }
  finally { release.resolve() }
  expect(await job.done).toMatchObject({ status: 'aborted', files: 0 })
  expect(reads).toBe(1)
  expect(() => fstatSync(fd)).toThrow()
  expect(vi.getTimerCount()).toBe(0)
})

it('refuses links, directories and oversized files without following or allocating their contents', async () => {
  const root = tempDir(), ordinary = write(join(root, 'ordinary'), 'unread target')
  const link = join(root, 'link'); symlinkSync(ordinary, link)
  const oversized = write(join(root, 'large'), '')
  truncateSync(oversized, 512 * 1024 * 1024 + 1)
  for (const path of [link, root, oversized]) {
    await expect(prefetchHostedCliFiles({ claude_code: path }).done).resolves.toEqual({ status: 'partial', files: 0, bytes: 0 })
  }
})

it('cannot block on a FIFO before checking its file type', async () => {
  const root = tempDir(), fifo = join(root, 'fifo')
  execFileSync('mkfifo', [fifo])
  const module = new URL('../src/hosted-cli-prefetch.ts', import.meta.url).href
  const source = `import { prefetchHostedCliFiles } from ${JSON.stringify(module)}; console.log(JSON.stringify(await prefetchHostedCliFiles({claude_code:process.argv[1]}).done))`
  const value = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, fifo], { encoding: 'utf8', timeout: 5000 })
  expect(JSON.parse(value)).toEqual({ status: 'partial', files: 0, bytes: 0 })
})

it('keeps read failures optional and closes the failed file without skipping a different selected CLI', async () => {
  const f = installation(), original = actualFs.open
  const descriptors: number[] = []
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await original(...args)
    descriptors.push(handle.fd)
    if (String(args[0]) === f.claude) vi.spyOn(handle, 'read').mockRejectedValue(Object.assign(Error('synthetic disk refusal'), { code: 'EIO' }))
    return handle
  })
  expect(await prefetchHostedCliFiles({ claude_code: f.claude, codex: f.launcher }).done)
    .toEqual({ status: 'partial', files: 2, bytes: statSync(f.launcher).size + statSync(f.native).size })
  for (const fd of descriptors) expect(() => fstatSync(fd)).toThrow()
})
