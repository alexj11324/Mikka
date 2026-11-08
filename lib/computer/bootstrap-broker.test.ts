import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, symlinkSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandInputHandle } from 'e2b'
import { WORKER_BOOTSTRAP_BROKER_SOURCE } from '../../packages/daemon/src/cloud-bootstrap-broker.mjs'
import { openWorkerBootstrapBroker, WORKER_BROKER_SHA256, workerBrokerCommand, type WorkerBrokerConfig } from './bootstrap-broker'
import { REGISTRATION_COMPLETE, quoteShell } from './registration-command'

const hash = (data: string) => createHash('sha256').update(data).digest('hex')
const runId = '11111111-1111-4111-8111-111111111111', leaseId = '22222222-2222-4222-8222-222222222222'
const deviceId = '33333333-3333-4333-8333-333333333333', workspaceId = '44444444-4444-4444-8444-444444444444'
const credential = 'orv_broker_test_only_no_provider_credential', tokenSha256 = hash(credential)

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mikka-broker-'))
  const runtimeRoot = join(root, 'runtime'), source = join(runtimeRoot, 'releases', 'b'.repeat(40), 'source')
  const cloud = join(source, 'packages/daemon/dist/cloud'), directory = join(root, 'worker'), handoff = join(root, 'thread-' + leaseId + '.json')
  mkdirSync(cloud, { recursive: true }); mkdirSync(directory)
  symlinkSync(source, join(runtimeRoot, 'worker'))
  writeFileSync(join(runtimeRoot, 'worker-source-sha'), 'a'.repeat(40), { mode: 0o444 })
  writeFileSync(join(source, '../worker-ready.sha'), 'a'.repeat(40), { mode: 0o444 })
  const capability = join(cloud, 'runtime-capabilities.json'), resource = join(cloud, 'bootstrap-broker.mjs')
  writeFileSync(capability, JSON.stringify({ registrationNoticeVersion: 1, workerSha: 'a'.repeat(40) }), { mode: 0o444 })
  writeFileSync(resource, WORKER_BOOTSTRAP_BROKER_SOURCE, { mode: 0o444 })
  const published = join(root, 'published'), fallback = join(root, 'fallback')
  const receipt = JSON.stringify({ version: 1, deviceId, workspaceId, tokenSha256 })
  const config: WorkerBrokerConfig = {
    runId, leaseId, workerSha: 'a'.repeat(40), runtimeRoot, directory, handoff,
    prepare: ':', publish: 'cp ' + quoteShell(handoff) + ' ' + quoteShell(published),
    wake: quoteShell(process.execPath) + ' -e ' + quoteShell("const fs=require('node:fs');fs.writeFileSync(process.argv[1],process.argv[2],{mode:0o600});fs.renameSync(process.argv[1],process.argv[3]);process.stdout.write('awake')") +
      ' ' + quoteShell(join(directory, 'registration.next')) + ' ' + quoteShell(receipt) + ' ' + quoteShell(join(directory, 'registration.json')),
    wakeReceipt: 'awake', start: 'touch ' + quoteShell(fallback), timeoutMs: 3000, registrationTimeoutMs: 1000,
  }
  const bootstrap = JSON.stringify({ deviceId, workspaceId, credential, server: 'https://example.invalid' })
  const files = [
    { path: handoff, data: bootstrap },
    { path: handoff + '.run', data: JSON.stringify({ version: 1, runId, bootstrapSha256: hash(bootstrap) }) },
    { path: handoff + '.claude', data: '' }, { path: handoff + '.codex', data: '' },
  ]
  const upload = () => { for (const file of files) writeFileSync(file.path, file.data, { mode: 0o600 }) }
  let child: ReturnType<typeof spawn> | undefined
  let loseResponse!: (cause: Error) => void
  const responseLoss = new Promise<never>((_resolve, reject) => { loseResponse = reject })
  void responseLoss.catch(() => {})
  const transport = { loseInputAfterCommit: false }
  const counts = { run: 0, input: 0, kill: 0, frames: [] as string[], inputAcknowledged: false, disconnect: 0 }
  const commands = {
    async run(command: string, options: { onStdout?: (chunk: string) => void }) {
      counts.run++
      // Execute the actual loader/resource with this runner's Node; no E2B/API.
      const local = command.replace('exec /opt/mikka/runtime/node/bin/node', 'exec ' + quoteShell(process.execPath))
      child = spawn('/bin/sh', ['-c', local], { stdio: ['pipe', 'pipe', 'pipe'] })
      child.stdin!.on('error', () => {})
      let stdout = '', stderr = '', exitCode: number | undefined
      child.stdout!.on('data', chunk => { stdout += chunk; options.onStdout?.(chunk.toString()) })
      child.stderr!.on('data', chunk => { stderr += chunk })
      const result = new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
        child!.once('error', reject)
        child!.once('close', code => {
          exitCode = code ?? 1
          if (exitCode) reject(Object.assign(Error('Local broker failed'), { stdout, stderr, exitCode }))
          else resolve({ stdout, stderr, exitCode })
        })
      })
      void result.catch(() => {})
      return { pid: child.pid!, wait: () => Promise.race([result, responseLoss]), get exitCode() { return exitCode }, disconnect: async () => { counts.disconnect++ } }
    },
    streamInput(pid: number, options: { signal?: AbortSignal; timeoutMs?: number }) {
      counts.input++
      assert.equal(pid, child!.pid)
      // Use the installed E2B 2.61 ordered generator and close acknowledgement.
      const rpc = { async streamInput(requests: AsyncIterable<{ event: { case: string; value: any } }>, _options: unknown) {
        for await (const request of requests) {
          const { event } = request
          if (event.case === 'start') assert.equal(event.value.process.selector.value, pid)
          else if (event.case === 'data') {
            const raw = Buffer.from(event.value.input.input.value).toString()
            counts.frames.push(raw)
            if (!child!.stdin!.destroyed) child!.stdin!.write(raw)
            if (transport.loseInputAfterCommit && JSON.parse(raw).kind === 'commit') throw Error('fixture input stream lost')
          } else assert.fail('normal bounded protocol does not need keepalive')
        }
        child!.stdin!.end(); counts.inputAcknowledged = true
      } }
      return new CommandInputHandle(rpc as never, pid, 'stdin' as never, options, (async () => {}) as never)
    },
    async kill(pid: number) {
      counts.kill++; assert.equal(pid, child!.pid)
      child!.kill('SIGKILL'); return true
    },
  }
  return { root, source, cloud, capability, resource, config, files, upload, published, fallback, counts, transport,
    loseResponse: () => loseResponse(Error('fixture response stream lost')),
    sandbox: { commands } as never,
    remove() { if (child && child.exitCode === null) child.kill('SIGKILL'); rmSync(root, { recursive: true, force: true }) },
  }
}

test('real broker and installed E2B input handle publish only after the one complete commit', async () => {
  const f = fixture(); let broker: Awaited<ReturnType<typeof openWorkerBootstrapBroker>> | undefined
  try {
    broker = await openWorkerBootstrapBroker(f.sandbox, f.config)
    assert.equal(broker.active, true); assert.equal(existsSync(f.published), false)
    assert.equal(f.counts.input, 1); assert.equal(f.counts.frames.length, 0)
    f.upload(); await broker.commit(f.files, { deviceId, workspaceId, tokenSha256 })
    const result = await broker.result
    assert.ok(result.stdout.includes(REGISTRATION_COMPLETE)); assert.equal(readFileSync(f.published, 'utf8'), f.files[0].data)
    await assert.rejects(broker.commit(f.files, { deviceId, workspaceId, tokenSha256 }), /not awaiting/)
    await broker.close(); await broker.close()
    assert.deepEqual({ run: f.counts.run, input: f.counts.input, kill: f.counts.kill }, { run: 1, input: 1, kill: 0 })
    assert.equal(f.counts.frames.length, 1); assert.equal(f.counts.inputAcknowledged, true)
    assert.equal(existsSync(f.fallback), false)
  } finally { await broker?.close().catch(() => {}); f.remove() }
})

for (const fault of ['missing_file', 'changed_file', 'symlink_file', 'wrong_locator', 'release_change'] as const) {
  test('the real broker refuses ' + fault + ' without publishing or starting', async () => {
    const f = fixture(); let broker: Awaited<ReturnType<typeof openWorkerBootstrapBroker>> | undefined
    try {
      broker = await openWorkerBootstrapBroker(f.sandbox, f.config); f.upload()
      if (fault === 'missing_file') rmSync(f.files[3].path)
      if (fault === 'changed_file') writeFileSync(f.files[0].path, f.files[0].data + ' ')
      if (fault === 'symlink_file') { rmSync(f.files[2].path); symlinkSync(f.files[1].path, f.files[2].path) }
      if (fault === 'wrong_locator') {
        f.files[1].data = JSON.stringify({ version: 1, runId: deviceId, bootstrapSha256: hash(f.files[0].data) }); f.upload()
      }
      if (fault === 'release_change') { chmodSync(join(f.config.runtimeRoot!, 'worker-source-sha'), 0o644); writeFileSync(join(f.config.runtimeRoot!, 'worker-source-sha'), 'c'.repeat(40)) }
      await broker.commit(f.files, { deviceId, workspaceId, tokenSha256 })
      await assert.rejects(broker.result)
      await broker.close()
      assert.equal(existsSync(f.published), false); assert.equal(existsSync(f.fallback), false)
      for (const file of f.files) assert.equal(existsSync(file.path), false)
    } finally { await broker?.close().catch(() => {}); f.remove() }
  })
}

for (const fault of ['resource_absent', 'resource_changed', 'capability_changed', 'wrong_owner_mode', 'missing_worker_link'] as const) {
  test('unsupported selected release remains an explicit legacy result: ' + fault, async () => {
    const f = fixture(); let broker: Awaited<ReturnType<typeof openWorkerBootstrapBroker>> | undefined
    try {
      if (fault === 'missing_worker_link') rmSync(join(f.config.runtimeRoot!, 'worker'))
      if (fault === 'resource_absent') rmSync(f.resource)
      if (fault === 'resource_changed') { chmodSync(f.resource, 0o644); writeFileSync(f.resource, "throw Error('must not execute')") }
      if (fault === 'capability_changed') { chmodSync(f.capability, 0o644); writeFileSync(f.capability, JSON.stringify({ registrationNoticeVersion: 2, workerSha: 'a'.repeat(40) })) }
      if (fault === 'wrong_owner_mode') chmodSync(f.resource, 0o666)
      broker = await openWorkerBootstrapBroker(f.sandbox, f.config)
      assert.equal(broker.active, false); assert.equal(broker.sourceSha, 'a'.repeat(40))
      assert.equal(f.counts.input, 0); assert.equal(existsSync(f.published), false)
      await assert.rejects(broker.commit(f.files, { deviceId, workspaceId, tokenSha256 }), /not awaiting/)
      await broker.close()
    } finally { await broker?.close().catch(() => {}); f.remove() }
  })
}

test('cancel before upload drains the single parked broker, retaining no watch or staging', async () => {
  const f = fixture(); let broker: Awaited<ReturnType<typeof openWorkerBootstrapBroker>> | undefined
  try {
    broker = await openWorkerBootstrapBroker(f.sandbox, f.config); f.upload()
    await broker.close(); await assert.rejects(broker.result)
    assert.equal(f.counts.run, 1); assert.equal(f.counts.input, 1); assert.equal(f.counts.kill, 0)
    assert.equal(JSON.parse(f.counts.frames[0]).kind, 'abort')
    assert.equal(existsSync(f.published), false)
    for (const file of f.files) assert.equal(existsSync(file.path), false)
  } finally { await broker?.close().catch(() => {}); f.remove() }
})

test('registration deadline remains a failure and does not start an acknowledged worker twice', async () => {
  const f = fixture(); let broker: Awaited<ReturnType<typeof openWorkerBootstrapBroker>> | undefined
  try {
    f.config.wake = 'printf awake'; f.config.registrationTimeoutMs = 80
    broker = await openWorkerBootstrapBroker(f.sandbox, f.config); f.upload()
    await broker.commit(f.files, { deviceId, workspaceId, tokenSha256 })
    await assert.rejects(broker.result, error => /cloud_registration_timeout/.test((error as { stderr: string }).stderr))
    await broker.close(); assert.equal(existsSync(f.fallback), false)
  } finally { await broker?.close().catch(() => {}); f.remove() }
})

test('parked lifetime is bounded and command never contains the credential bytes', async () => {
  const f = fixture(); let broker: Awaited<ReturnType<typeof openWorkerBootstrapBroker>> | undefined
  try {
    assert.equal(hash(WORKER_BOOTSTRAP_BROKER_SOURCE), WORKER_BROKER_SHA256)
    assert.equal(workerBrokerCommand(f.config).includes(credential), false)
    f.config.timeoutMs = 80
    broker = await openWorkerBootstrapBroker(f.sandbox, f.config)
    await assert.rejects(broker.result, error => /cloud_broker_timeout/.test((error as { stderr: string }).stderr))
    assert.throws(() => broker!.assertAwaitingUpload(), /not awaiting/)
    await broker.close(); assert.equal(existsSync(f.published), false)
  } finally { await broker?.close().catch(() => {}); f.remove() }
})

test('actual E2B 2.61 wire retains three requests and reduces total same-task bytes', async () => {
  const { createServer } = await import('node:http')
  const { Sandbox } = await import('e2b')
  const { registrationCommand } = await import('./registration-command')
  const { CLOUD_PRELOADER_WAKE_COMMAND, CLOUD_PRELOADER_WAKE_RECEIPT, CLOUD_WORKER_COMMAND } = await import('./worker-command')
  const { workerCommand } = await import('../cloud-computer/thread-worker-logs')
  const f = fixture()
  const directory = '/home/user/.mikka/worker', handoff = '/run/mikka-viewer/thread-' + leaseId + '.json'
  // Take the exact existing publication expression from the real orchestration
  // source, so bytes cover all four unchanged sidecars and the actual fallback.
  const source = readFileSync(new URL('../cloud-computer/thread-machines.ts', import.meta.url), 'utf8')
  const expression = source.split('\n').find(line => line.startsWith('    const publish = '))!.split(' = ').slice(1).join(' = ')
  const publish = new Function('handoff', 'return ' + expression)(handoff) as string
  const config: WorkerBrokerConfig = { runId, leaseId, workerSha: 'a'.repeat(40), handoff, directory,
    prepare: 'install -d -o user -g user -m 700 /home/user/.mikka ' + directory,
    publish, wake: 'runuser -u user -- sh -c ' + quoteShell(CLOUD_PRELOADER_WAKE_COMMAND),
    wakeReceipt: CLOUD_PRELOADER_WAKE_RECEIPT, start: 'runuser -u user -- sh -c ' + quoteShell(workerCommand(CLOUD_WORKER_COMMAND)),
    timeoutMs: 40_000, registrationTimeoutMs: 30_000 }
  const oldCommand = config.prepare + ' && ' + registrationCommand({
    directory, deviceId, workspaceId, workerSha: config.workerSha, tokenSha256,
    publish, wake: config.wake, wakeReceipt: config.wakeReceipt, start: config.start, timeoutMs: 30_000,
  })
  const files = f.files.map((file, index) => ({ path: handoff + ['', '.run', '.claude', '.codex'][index], data: file.data }))
  const envelope = (value: unknown, flags = 0) => {
    const data = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(5)
    header[0] = flags; header.writeUInt32BE(data.length, 1); return Buffer.concat([header, data])
  }
  type Wire = { method: string; path: string; requestHeadersBytes: number; requestBodyBytes: number; responseHeadersBytes: number; responseBodyBytes: number }
  const observed = { old: [] as Wire[], broker: [] as Wire[], legacy: [] as Wire[] }
  let mode: keyof typeof observed = 'old', live: import('node:http').ServerResponse | undefined
  let liveWire: Wire | undefined, uploaded = false, receivedCommit = false, starts = 0
  const writeEvent = (res: import('node:http').ServerResponse, row: Wire, value: unknown, flags = 0) => {
    const bytes = envelope(value, flags); row.responseBodyBytes += bytes.length; res.write(bytes)
  }
  const finish = (res: import('node:http').ServerResponse, row: Wire, stdout: string) => {
    writeEvent(res, row, { event: { data: { stdout: Buffer.from(stdout).toString('base64') } } })
    writeEvent(res, row, { event: { end: { exitCode: 0 } } })
    writeEvent(res, row, {}, 2); res.end()
  }
  const server = createServer((req, res) => {
    const path = new URL(req.url!, 'http://127.0.0.1').pathname
    const row = { method: req.method!, path, requestHeadersBytes: Buffer.byteLength(req.method + ' ' + req.url + ' HTTP/1.1\r\n' +
      Array.from({ length: req.rawHeaders.length / 2 }, (_, i) => req.rawHeaders[i * 2] + ': ' + req.rawHeaders[i * 2 + 1] + '\r\n').join('') + '\r\n'),
      requestBodyBytes: 0, responseHeadersBytes: 0, responseBodyBytes: 0 }
    observed[mode].push(row)
    res.on('finish', () => { row.responseHeadersBytes = Buffer.byteLength((res as unknown as { _header: string })._header) })
    let chunks = Buffer.alloc(0)
    if (path.endsWith('/StreamInput')) {
      res.writeHead(200, { 'content-type': 'application/connect+json' })
      req.on('data', part => {
        row.requestBodyBytes += part.length; chunks = Buffer.concat([chunks, part])
        while (chunks.length >= 5 && chunks.length >= 5 + chunks.readUInt32BE(1)) {
          const size = chunks.readUInt32BE(1), frame = JSON.parse(chunks.subarray(5, size + 5).toString()); chunks = chunks.subarray(size + 5)
          if (frame.data) {
            const data = JSON.parse(Buffer.from(frame.data.input.stdin, 'base64').toString())
            assert.equal(data.kind, 'commit'); assert.equal(uploaded, true)
            assert.equal(receivedCommit, false); receivedCommit = true
            finish(live!, liveWire!, 'mikka-worker-registration-wait\n' + REGISTRATION_COMPLETE + '\n')
          } else assert.equal(frame.start.process.pid, 42)
        }
      })
      req.on('end', () => { writeEvent(res, row, {}); writeEvent(res, row, {}, 2); res.end() })
      return
    }
    req.on('data', part => { row.requestBodyBytes += part.length; chunks = Buffer.concat([chunks, part]) })
    req.on('end', () => {
      if (path === '/files') {
        const body = req.method === 'GET' ? 'a'.repeat(40) : JSON.stringify(files.map(file => ({ path: file.path, name: file.path, type: 'file' })))
        if (req.method === 'POST') { assert.equal(receivedCommit, false); uploaded = true }
        res.writeHead(200, { 'content-type': req.method === 'GET' ? 'text/plain' : 'application/json' })
        row.responseBodyBytes = Buffer.byteLength(body); res.end(body)
      } else if (path.endsWith('/Start')) {
        res.writeHead(200, { 'content-type': 'application/connect+json' })
        writeEvent(res, row, { event: { start: { pid: 42 } } })
        starts++
        if (mode === 'old' || (mode === 'legacy' && starts === 2)) finish(res, row, REGISTRATION_COMPLETE + '\n')
        else if (mode === 'legacy') finish(res, row, 'mikka-worker-broker-attestation ' + JSON.stringify({ version: 1, runId, leaseId, sourceSha: config.workerSha, broker: false }) + '\n')
        else {
          live = res; liveWire = row
          writeEvent(res, row, { event: { data: { stdout: Buffer.from('mikka-worker-broker-attestation ' +
            JSON.stringify({ version: 1, runId, leaseId, sourceSha: config.workerSha, broker: true }) + '\n').toString('base64') } } })
        }
      } else { res.statusCode = 500; res.end(); assert.fail('unexpected provider route: ' + path) }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as import('node:net').AddressInfo).port
  const sandbox = Reflect.construct(Sandbox, [{ sandboxId: 'fixture-same-task', envdVersion: '0.4.0',
    sandboxUrl: 'http://127.0.0.1:' + port, apiKey: 'fixture-only', envdAccessToken: 'fixture-only', httpVersion: '1.1', retries: 0 }]) as InstanceType<typeof Sandbox>
  let broker: Awaited<ReturnType<typeof openWorkerBootstrapBroker>> | undefined
  try {
    assert.equal(await sandbox.files.read('/opt/mikka/worker-source-sha', { user: 'root' }), config.workerSha)
    await sandbox.files.write(files, { user: 'root', useOctetStream: false })
    await sandbox.commands.run(oldCommand, { user: 'root', timeoutMs: 40_000 })
    mode = 'broker'; uploaded = false; starts = 0
    broker = await openWorkerBootstrapBroker(sandbox, config)
    await sandbox.files.write(files, { user: 'root', useOctetStream: false })
    await broker.commit(files, { deviceId, workspaceId, tokenSha256 })
    await broker.result; await broker.close()
    mode = 'legacy'; uploaded = false; receivedCommit = false; starts = 0
    const legacy = await openWorkerBootstrapBroker(sandbox, config)
    assert.equal(legacy.active, false)
    await sandbox.files.write(files, { user: 'root', useOctetStream: false })
    await sandbox.commands.run(oldCommand, { user: 'root', timeoutMs: 40_000 })
    await legacy.close()
    const total = (rows: Wire[]) => rows.reduce((n, row) => n + row.requestHeadersBytes + row.requestBodyBytes + row.responseHeadersBytes + row.responseBodyBytes, 0)
    assert.equal(observed.old.length, 3); assert.equal(observed.broker.length, 3); assert.equal(observed.legacy.length, 3)
    assert.equal(observed.old.find(row => row.method === 'POST' && row.path === '/files')!.requestBodyBytes,
      observed.broker.find(row => row.method === 'POST' && row.path === '/files')!.requestBodyBytes)
    const evidence = { sdk: '2.61.0', transport: 'actual SDK against loopback only', old: observed.old, broker: observed.broker, legacy: observed.legacy,
      oldBytes: total(observed.old), brokerBytes: total(observed.broker), legacyBytes: total(observed.legacy),
      excludes: ['TCP/TLS/HTTP2 and HTTP chunk framing', 'production latency'], uploadedFiles: 4 }
    console.log('worker-broker-wire ' + JSON.stringify(evidence))
    assert.ok(evidence.brokerBytes < evidence.oldBytes, 'the whole normal task must reduce measured bytes, including the new input manifest')
  } finally {
    await broker?.close().catch(() => {})
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); f.remove()
  }
})

test('a missing preloader invokes the original detached fallback exactly once', async () => {
  const f = fixture(); let broker: Awaited<ReturnType<typeof openWorkerBootstrapBroker>> | undefined
  try {
    f.config.start = 'printf x >> ' + quoteShell(f.fallback) + ' && ' + f.config.wake
    f.config.wake = ':'
    broker = await openWorkerBootstrapBroker(f.sandbox, f.config); f.upload()
    await broker.commit(f.files, { deviceId, workspaceId, tokenSha256 }); await broker.result; await broker.close()
    assert.equal(readFileSync(f.fallback, 'utf8'), 'x')
  } finally { await broker?.close().catch(() => {}); f.remove() }
})

for (const fault of ['none', 'response', 'input'] as const) test('cancel after upload preserves cleanup ownership: ' + fault, async () => {
  const { watch } = await import('node:fs')
  const f = fixture(); let broker: Awaited<ReturnType<typeof openWorkerBootstrapBroker>> | undefined
  const marker = join(f.root, 'publication-entered')
  let watcher: ReturnType<typeof watch> | undefined, timer: ReturnType<typeof setTimeout> | undefined
  try {
    const entered = new Promise<void>((resolve, reject) => {
      watcher = watch(f.root, (_event, name) => { if (String(name) === 'publication-entered') resolve() })
      timer = setTimeout(() => reject(Error('publication did not begin')), 2000)
    })
    if (fault === 'input') { f.transport.loseInputAfterCommit = true; f.config.timeoutMs = 500 }
    f.config.publish = quoteShell(process.execPath) + ' -e ' + quoteShell("require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)") + ' ' + quoteShell(marker)
    broker = await openWorkerBootstrapBroker(f.sandbox, f.config); f.upload()
    await broker.commit(f.files, { deviceId, workspaceId, tokenSha256 }); await entered
    clearTimeout(timer); watcher?.close()
    const ownedPid = Number(readFileSync(marker, 'utf8'))
    if (fault === 'response') f.loseResponse()
    if (fault === 'input') {
      await assert.rejects(broker.close(), /unconfirmed/)
      assert.equal(f.counts.kill, 0, 'do not kill just the parent after losing an in-flight commit acknowledgement')
    } else await broker.close()
    await assert.rejects(broker.result)
    let state: string | undefined
    try { state = readFileSync('/proc/' + ownedPid + '/stat', 'utf8').split(') ')[1]?.[0] }
    catch (cause) { assert.equal((cause as NodeJS.ErrnoException).code, 'ENOENT') }
    assert.ok(state === undefined || state === 'Z', 'owned publication descendant is no longer executing')
    assert.equal(existsSync(f.fallback), false)
  } finally { clearTimeout(timer); watcher?.close(); await broker?.close().catch(() => {}); f.remove() }
})
