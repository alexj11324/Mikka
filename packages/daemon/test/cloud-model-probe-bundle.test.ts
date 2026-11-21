import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Metafile } from 'esbuild'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { CAPTURE_TOOLCHAIN, CAPTURE_TOOLS_ROOT } from '../src/agents/capture-video.mjs'

const root = mkdtempSync(join(tmpdir(), 'mikka-probe-bundle-'))
const source = join(root, 'releases', 'fixture', 'source')
const out = join(source, 'packages', 'daemon', 'dist', 'cloud')
const linked = join(root, 'worker')
let metadata: Metafile

beforeAll(async () => {
  // A catalogue fixture may never select an installed machine's actual CLIs.
  expect(existsSync('/opt/mikka/worker/.mikka-original-cli.json')).toBe(false)
  expect(existsSync('/opt/mikka/original-cli.json')).toBe(false)
  const { buildCloudWorker } = await import(new URL('../scripts/build-cloud-worker.mjs', import.meta.url).href) as {
    buildCloudWorker(out: string): Promise<Metafile>
  }
  metadata = await buildCloudWorker(out)
  writeFileSync(join(source, 'package.json'), '{"type":"module"}\n')
  symlinkSync(source, linked, 'dir')
}, 30_000)

afterAll(() => rmSync(root, { recursive: true, force: true }))

function active(pid: number) {
  try {
    if (process.platform === 'linux') return !/\) [ZX] /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))
    process.kill(pid, 0)
    return true
  } catch { return false }
}

function fixture(failClaude = false) {
  const directory = mkdtempSync(join(root, 'peers-'))
  const bin = join(directory, 'bin'), scratch = join(directory, 'tmp'), cwd = join(directory, 'unrelated-cwd')
  for (const path of [bin, scratch, cwd]) mkdirSync(path)
  for (const harness of ['claude_code', 'codex']) {
    const path = join(bin, harness === 'claude_code' ? 'claude' : 'codex')
    writeFileSync(path, `#!${process.execPath}
const { writeFileSync } = require('node:fs')
writeFileSync(${JSON.stringify(join(directory, `${harness}.json`))}, JSON.stringify({ pid: process.pid, home: process.env.HOME, env: Object.keys(process.env).sort() }))
if (${failClaude && harness === 'claude_code'}) { process.stderr.write('fixture-private-provider-error'); process.exit(7) }
let buffer = ''
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
process.stdin.on('data', chunk => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const value = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1)
    if (value.id === 1) send({ id: 1, result: {} })
    else if (value.id === 2) send({ id: 2, result: { data: [{ id: 'fixture-codex', model: 'fixture-codex', isDefault: true }] } })
    else if (value.type === 'control_request') send({ type: 'control_response', response: { subtype: 'success', response: { models: [{ value: 'fixture-claude', resolvedModel: 'fixture-claude' }] } } })
  }
})
`)
    chmodSync(path, 0o700)
  }
  const run = () => spawnSync(process.execPath, [join(linked, 'packages', 'daemon', 'dist', 'cloud', 'cloud-model-probe.js')], {
    cwd, encoding: 'utf8', timeout: 8_000, maxBuffer: 1024 * 1024,
    env: { PATH: bin, HOME: directory, TMPDIR: scratch, LANG: 'C.UTF-8', ANTHROPIC_API_KEY: 'fixture-secret-sentinel', GH_TOKEN: 'fixture-secret-sentinel' },
  })
  const receipts = () => ['claude_code', 'codex'].map(harness => JSON.parse(readFileSync(join(directory, `${harness}.json`), 'utf8')) as { pid: number; home: string; env: string[] })
  const clean = () => {
    for (const harness of ['claude_code', 'codex']) {
      const file = join(directory, `${harness}.json`)
      if (!existsSync(file)) continue
      const { pid } = JSON.parse(readFileSync(file, 'utf8')) as { pid: number }
      if (active(pid)) {
        try { process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL') } catch { /* The owned fixture already exited. */ }
      }
    }
    rmSync(directory, { recursive: true, force: true })
  }
  return { run, receipts, clean, scratch }
}

it('builds a separate probe graph with only Node runtime imports and keeps normal worker assets', () => {
  const probe = Object.values(metadata.outputs).find(output => output.entryPoint === 'bin/cloud-model-probe.ts')
  expect(probe).toBeDefined()
  expect(probe!.imports.every(item => item.external && isBuiltin(item.path))).toBe(true)
  const inputs = Object.keys(probe!.inputs)
  expect(inputs).toContain('src/cloud-model-probe.ts')
  expect(inputs).toContain('src/model-probe.ts')
  expect(inputs.some(path => /(?:^|\/)(?:cli|main|tracing)\.ts$|(?:^|\/)coordinator\/|claude-agent-sdk|(?:^|\/)pino(?:\/|$)/.test(path))).toBe(false)
  expect(existsSync(join(out, 'cloud-model-probe.js'))).toBe(true)
  for (const path of ['cloud-worker.js', 'mikka-mcp.mjs', 'agents/native-container.mjs', 'computer/proxy.mjs', 'computer/driver.mjs', 'fixtures/success-edit.jsonl']) {
    expect(existsSync(resolve(out, path))).toBe(true)
  }
})

it('runs the built probe through the release symlink from another cwd without SDK packages or credentials', () => {
  const peer = fixture()
  try {
    const result = peer.run()
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject([
      { harness: 'claude_code', installed: true, models: ['fixture-claude'] },
      { harness: 'codex', installed: true, models: ['fixture-codex'] },
    ])
    for (const receipt of peer.receipts()) {
      expect(receipt.env).toEqual(['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HOME', 'LANG', 'PATH'])
      expect(active(receipt.pid)).toBe(false)
      expect(existsSync(receipt.home)).toBe(false)
    }
    expect(readdirSync(peer.scratch)).toEqual([])
  } finally { peer.clean() }
})

it('fails a real built-probe exchange without printing CLI content and drains both owned children', () => {
  const peer = fixture(true)
  try {
    const result = peer.run()
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Cloud model probe unavailable\n')
    for (const receipt of peer.receipts()) {
      expect(active(receipt.pid)).toBe(false)
      expect(existsSync(receipt.home)).toBe(false)
    }
    expect(readdirSync(peer.scratch)).toEqual([])
  } finally { peer.clean() }
})

it('only the actual notice-capable worker builder emits its release capability', async () => {
  const previous = process.env.MIKKA_CLOUD_WORKER_BUILD_SHA
  const capabilityOut = join(root, 'capability-build')
  const capability = join(capabilityOut, 'runtime-capabilities.json')
  const workerSha = 'c'.repeat(40)
  const { buildCloudWorker } = await import(new URL('../scripts/build-cloud-worker.mjs', import.meta.url).href) as {
    buildCloudWorker(out: string): Promise<Metafile>
  }
  try {
    process.env.MIKKA_CLOUD_WORKER_BUILD_SHA = workerSha
    const built = await buildCloudWorker(capabilityOut)
    expect(Object.keys(built.inputs)).toContain('src/cloud-registration.ts')
    expect(Object.keys(built.inputs)).toContain('src/agents/capture-video.mjs')
    // The compiled worker selects the same immutable pair as the standalone
    // helper copied to the computer VM, rather than assuming a system PATH.
    const workerBundle = readFileSync(join(capabilityOut, 'cloud-worker.js'), 'utf8')
    expect(workerBundle).toContain(CAPTURE_TOOLS_ROOT)
    expect(workerBundle).toContain(CAPTURE_TOOLCHAIN.id)
    expect(JSON.parse(readFileSync(capability, 'utf8'))).toEqual({ registrationNoticeVersion: 1, workerSha })
    expect(statSync(capability).mode & 0o777).toBe(0o444)
    // A legacy installer does not supply this identity. The new builder must
    // neither invent it nor leave a stale declaration from an earlier build.
    delete process.env.MIKKA_CLOUD_WORKER_BUILD_SHA
    await buildCloudWorker(capabilityOut)
    expect(existsSync(capability)).toBe(false)
  } finally {
    if (previous === undefined) delete process.env.MIKKA_CLOUD_WORKER_BUILD_SHA
    else process.env.MIKKA_CLOUD_WORKER_BUILD_SHA = previous
  }
}, 30_000)

it('rejects a malformed supplied worker identity without publishing a capability', async () => {
  const previous = process.env.MIKKA_CLOUD_WORKER_BUILD_SHA
  const capabilityOut = join(root, 'invalid-capability-build')
  const { buildCloudWorker } = await import(new URL('../scripts/build-cloud-worker.mjs', import.meta.url).href) as {
    buildCloudWorker(out: string): Promise<Metafile>
  }
  try {
    process.env.MIKKA_CLOUD_WORKER_BUILD_SHA = 'not-a-worker-sha'
    await expect(buildCloudWorker(capabilityOut)).rejects.toThrow('Invalid worker build identity')
    expect(existsSync(join(capabilityOut, 'runtime-capabilities.json'))).toBe(false)
  } finally {
    if (previous === undefined) delete process.env.MIKKA_CLOUD_WORKER_BUILD_SHA
    else process.env.MIKKA_CLOUD_WORKER_BUILD_SHA = previous
  }
}, 30_000)
