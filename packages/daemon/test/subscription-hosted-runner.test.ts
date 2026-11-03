import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { defaultRunPolicy, type RunAssignment } from "@mikka/protocol";
import { createHostedBotRunner } from "../src/subscription-hosted-runner";
import { DaemonError, ServerUnreachableError } from "../src/errors";
import { MemoryServer } from "../src/server-link";
import { createLogger } from "../src/log";
import { buildChildEnv } from "../src/env";
import { ComputerBroker } from "../src/computer/broker.mjs";
import { ToolApprovalGate } from "../src/agents/tool-approval";
import { Daemon } from "../src/main";
import type { AgentSession } from "../src/adapters/types";
import { cleanupTempDirs, makeRepo, tempDir, waitFor } from "./helpers";

afterEach(cleanupTempDirs);
for (const harness of ["codex", "claude_code"] as const) {
  it(`runs ${harness} through the existing adapter directly on the machine, with no sandbox or Docker, and retains the owner session ledger`, async () => {
    const root = tempDir("mnh-");
    const stateDir = join(root, "adapters");
    mkdirSync(stateDir);
    writeFileSync(join(root, "device.json"), '{"credential":"fixture-device-credential"}', { mode: 0o600 });
    const runId = randomUUID();
    const consumerId = randomUUID();
    const bindingId = randomUUID();
    const workspaceId = randomUUID();
    const deviceId = randomUUID();
    let connected = true;
    const context = vi.fn(async () => {
      if (!connected) throw new Error("revoked");
      return {
        route:
          harness === "codex"
            ? ("codex_cli" as const)
            : ("claude_code_cli" as const),
        modelId: "fixture-model",
        revision: 2,
        accountId: "fixture-account",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
    });
    const link = Object.assign(new MemoryServer(deviceId).link(), {
      nativeContext: context,
      nativeRequest: vi.fn(async () => {
        throw new Error("fixture CLI must not call provider");
      }),
    });
    const binary = resolve(
      import.meta.dirname,
      "fakes",
      harness === "codex"
        ? "fake-codex-subscription.mjs"
        : "fake-claude-subscription.mjs",
    );
    chmodSync(binary, 0o700);
    const runner = await createHostedBotRunner({
      stateDir,
      link,
      binaries: { [harness]: binary },
      ...(process.env.MIKKA_E2B_TEST_DOCKER === '1' ? { dockerSocket: "unix:///run/mikka-container/docker.sock" as const } : {}),
    });
    const assignment = {
      runId,
      deviceId,
      issueId: randomUUID(),
      repoId: randomUUID(),
      baseBranch: "main",
      harness,
      prompt: "hello",
      model: "fixture-model",
      subscriptionBinding: {
        bindingId,
        ownerId: "fixture-owner",
        workspaceId,
        consumerId,
        route: harness === "codex" ? "codex_cli" : "claude_code_cli",
      },
    } as RunAssignment;
    const options = {
      runId,
      toolApproval: new ToolApprovalGate(runId, { isLive: () => true }),
      cwd: await makeRepo(),
      prompt: "PROBE_GIT",
      model: "fixture-model",
      env: buildChildEnv({ host: { PATH: process.env.PATH, HOME: tempDir() } }),
      log: createLogger({ level: "silent" }),
      github: { endpoint: 'https://mikka.example/api/runs/github-token', repository: 'owner/repo', branch: 'mikka/mik-1', runToken: 'synthetic-run-token', issueId: assignment.issueId },
    };
    const githubDir = join(stateDir, 'runs', runId, 'github');
    mkdirSync(githubDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(githubDir, 'config.json.cache'), JSON.stringify({ repository: 'owner/repo', token: 'synthetic-installation-token', createdAt: Date.now(), expiresAt: new Date(Date.now() + 3600_000).toISOString() }), { mode: 0o600 });
    const before = readFileSync(join(options.cwd, ".git", "config"), "utf8");
    const session = await runner.start(assignment, options);
    const events = [];
    for await (const event of session.events()) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "exit", outcome: "succeeded" });
    expect(JSON.stringify(events)).not.toContain(
      "mikka-native-broker-placeholder",
    );
    const ledger = join(stateDir, "native-ledgers", runId + ".json");
    expect(JSON.parse(readFileSync(ledger, "utf8"))).toMatchObject({
      scope: { ownerId: "fixture-owner", bindingId },
      sessionId: session.sessionId,
    });
    expect(
      existsSync(join(stateDir, "runs", runId, "runtime-git", ".git")),
    ).toBe(true);
    expect(execFileSync('git', ['--git-dir', join(stateDir, 'runs', runId, 'runtime-git', '.git'), '--work-tree', options.cwd, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
    // Closing the session leaves no GitHub token cache or CLI login on the machine.
    expect(existsSync(githubDir)).toBe(false);
    expect(existsSync(join(stateDir, "runs", runId, "runtime-home", ".codex", "auth.json"))).toBe(false);
    expect(existsSync(join(stateDir, "runs", runId, "runtime-home", ".claude", ".credentials.json"))).toBe(false);
    connected = false;
    // Completed sessions revoke their own gate. A restart needs a fresh host
    // gate before the independently revoked subscription context is consulted.
    options.toolApproval = denyGate(runId);
    await expect(runner.start(assignment, options)).rejects.toThrow("revoked");
    const verify = await runner.command(
      options.cwd,
      'test -z "$(git status --porcelain)" && test -z "$E2B_API_KEY$INFISICAL_CLIENT_SECRET" && printf allowed > project-probe',
      false,
      10000,
    );
    expect(verify.exitCode).toBe(0);
    expect(verify.timedOut).toBe(false);
    expect(verify.timing.runMs).toBeLessThan(10000);
    expect(readFileSync(join(options.cwd, "project-probe"), "utf8")).toBe(
      "allowed",
    );
    expect(readFileSync(join(options.cwd, ".git", "config"), "utf8")).toBe(
      before,
    );
  }, 45000);
}

it.each([
  ['codex', 'ask'], ['codex', 'allow'], ['codex', 'deny'],
  ['claude_code', 'ask'], ['claude_code', 'allow'], ['claude_code', 'deny'],
] as const)('applies hosted %s computer policy %s to its Bot-bound broker', async (harness, permission) => {
  const root = tempDir('mnh-computer-'), stateDir = join(root, 'adapters')
  mkdirSync(stateDir)
  let executions = 0
  const broker = new ComputerBroker({ socketPath: join(root, 'computer.sock'),
    driver: { installed: true, version: 'fixture', path: '/fake', fingerprint: 'f'.repeat(64) }, permitted: () => true,
    execute: async (_driver, call, display) => { executions++; expect(display).toBe(':2'); return { content: [{ type: 'text', text: JSON.stringify(call) }] } },
  })
  await broker.listen()
  try {
    const runId = randomUUID(), deviceId = randomUUID(), workspaceId = randomUUID(), botId = randomUUID()
    const link = Object.assign(new MemoryServer(deviceId).link(), {
      nativeContext: async () => ({ route: harness === 'codex' ? 'codex_cli' as const : 'claude_code_cli' as const, modelId: 'fixture-model', revision: 2, accountId: 'fixture-account', expiresAt: new Date(Date.now() + 60000).toISOString() }),
      nativeRequest: async () => { throw new Error('fixture must not call provider') },
    })
    const binary = resolve(import.meta.dirname, harness === 'codex' ? 'fakes/fake-codex-subscription.mjs' : 'fakes/fake-claude-subscription.mjs')
    chmodSync(binary, 0o700)
    const runner = await createHostedBotRunner({ stateDir, link, binaries: { [harness]: binary }, computerBroker: broker,
      ...(process.env.MIKKA_E2B_TEST_DOCKER === '1' ? { dockerSocket: 'unix:///run/mikka-container/docker.sock' as const } : {}) })
    const assignment = { runId, deviceId, issueId: randomUUID(), repoId: randomUUID(), baseBranch: 'main', harness, prompt: 'COMPUTER', model: 'fixture-model',
      policy: { ...defaultRunPolicy(), permissions: { ...defaultRunPolicy().permissions, computer_use: permission } },
      computer: { botId, ownerId: 'fixture-owner', display: ':2', policyVersion: 0 },
      subscriptionBinding: { bindingId: randomUUID(), ownerId: 'fixture-owner', workspaceId, consumerId: randomUUID(), route: harness === 'codex' ? 'codex_cli' : 'claude_code_cli' },
    } as RunAssignment
    const started = runner.start(assignment, { runId, toolApproval: denyGate(runId), policy: assignment.policy, cwd: await makeRepo(), prompt: 'COMPUTER', model: 'fixture-model', env: buildChildEnv({ host: { PATH: process.env.PATH, HOME: tempDir() } }), log: createLogger({ level: 'silent' }) })
    if (permission === 'deny') {
      await expect(started).rejects.toThrow('subscription_hosted_runtime_unavailable')
      expect(executions).toBe(0)
      expect(broker.list()).toHaveLength(0)
      return
    }
    const session = await started
    const finished = (async () => { const events = []; for await (const event of session.events()) events.push(event); return events })()
    if (permission === 'ask') {
      const review = await waitFor(() => broker.list()[0])
      expect(review).toMatchObject({ runId, display: ':2', call: { name: 'click', arguments: { x: 3, y: 4 } } })
      expect(executions).toBe(0)
      await broker.decide(review.id, review.digest, true)
    }
    expect((await finished).at(-1)).toMatchObject({ type: 'exit', outcome: 'succeeded' })
    expect(executions).toBe(1)
    expect(broker.list()).toHaveLength(0)
  } finally { await broker.close() }
}, 60000)

function denyGate(runId: string, live = () => true) {
  return new ToolApprovalGate(runId, { isLive: live })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), 15000)
    })])
  } finally { clearTimeout(timer) }
}
/**
 * The processes of one hosted run still alive: its bootstrap (whose working
 * directory is the run's worktree) and anything naming the fixture's root
 * (the CLI's settings carry the run dir).
 */
function liveRunProcesses(worktree: string, root: string): string[] {
  const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' })
  const real = realpathSync(worktree)
  return out.split('\n').map(line => line.trim()).filter(Boolean).filter(line => {
    const pid = line.split(' ', 1)[0]
    if (Number(pid) === process.pid) return false
    if (line.includes(root)) return true
    if (!line.includes('native-container.mjs')) return false
    try { return readlinkSync(`/proc/${pid}/cwd`) === real } catch { return false }
  })
}

// These fixtures run the real bootstrap and process groups on this machine
// with synthetic CLI/auth/provider protocol only. No production liveness or
// process result is faked.
async function revocationFixture(binaryName = 'fakes/fake-claude-subscription.mjs', harness: 'claude_code' | 'codex' = 'claude_code') {
  // Keep audit files outside the shared disposable-directory helper. Its
  // independent owner may recycle fixtures; these records must stay retained.
  const root = mkdtempSync(join(tmpdir(),'mikka-hosted-approval-')), stateDir = join(root, 'adapters')
  console.info(`Retained hosted approval audit: ${root}`)
  mkdirSync(stateDir)
  const runId = randomUUID(), deviceId = randomUUID()
  const contextValue = { route: harness === 'codex' ? 'codex_cli' as const : 'claude_code_cli' as const, modelId: 'fixture-model', revision: 2, accountId: 'fixture-account', expiresAt: new Date(Date.now() + 60000).toISOString() }
  const link = Object.assign(new MemoryServer(deviceId).link(), {
    nativeContext: vi.fn(async (_device: string, _run: string, _signal?: AbortSignal) => contextValue),
    nativeRequest: vi.fn(async (_device: string, _run: string, _payload: unknown, _signal?: AbortSignal): Promise<{ contentType: string; body: ReadableStream<Uint8Array> }> => { throw new Error('no real provider in hosted fixture') }),
  })
  const binary = binaryName.startsWith('/') ? binaryName : resolve(import.meta.dirname, binaryName)
  chmodSync(binary, 0o700)
  // A runner on this state directory, as a restarted daemon would open it.
  const open = () => createHostedBotRunner({ stateDir, link, binaries: { [harness]: binary }, ...(process.env.MIKKA_E2B_TEST_DOCKER === '1' ? { dockerSocket: 'unix:///run/mikka-container/docker.sock' as const } : {}) })
  const runner = await open()
  const assignment = { runId, deviceId, issueId: randomUUID(), repoId: randomUUID(), baseBranch: 'main', harness, prompt: 'HANG', model: 'fixture-model',
    subscriptionBinding: { bindingId: randomUUID(), ownerId: 'fixture-owner', workspaceId: randomUUID(), consumerId: randomUUID(), route: contextValue.route },
  } as RunAssignment
  let policyLive = true
  const gate = denyGate(runId, () => policyLive)
  const options = { runId, toolApproval: gate, cwd: await makeRepo(), prompt: 'HANG', model: 'fixture-model', env: buildChildEnv({ host: { PATH: process.env.PATH, HOME: tempDir() } }), log: createLogger({ level: 'silent' }) }
  const socket = () => {
    const brokers = join(stateDir, 'native-brokers')
    if (!existsSync(brokers)) return undefined
    return readdirSync(brokers).map(name => join(brokers, name, 'broker.sock')).find(path => existsSync(path))
  }
  const processes = () => liveRunProcesses(options.cwd, root)
  return { root, stateDir, runId, runner, open, link, assignment, options, gate, contextValue, binary, socket, processes,
    revokePolicy: () => { policyLive = false },
  }
}

it.each(['context', 'broker'] as const)('fences hosted startup revoked during %s and starts no CLI', async phase => {
  const fixture = await revocationFixture()
  const entered = deferred<void>(), resume = deferred<void>()
  if (phase === 'context') {
    await expect(fixture.runner.start(fixture.assignment, { ...fixture.options, toolApproval: undefined })).rejects.toThrow('Run tool approval unavailable')
    await expect(fixture.runner.start(fixture.assignment, { ...fixture.options, toolApproval: denyGate(randomUUID()) })).rejects.toThrow('Run tool approval unavailable')
    const stopped = denyGate(fixture.runId); stopped.revoke()
    await expect(fixture.runner.start(fixture.assignment, { ...fixture.options, toolApproval: stopped })).rejects.toThrow('Run tool approval unavailable')
    expect(fixture.link.nativeContext).not.toHaveBeenCalled()
  }
  fixture.link.nativeContext.mockImplementation(async () => {
    if (fixture.link.nativeContext.mock.calls.length === (phase === 'context' ? 1 : 2)) {
      entered.resolve()
      await resume.promise // Trusted server reply can arrive after cancellation.
    }
    return fixture.contextValue
  })
  const starting = fixture.runner.start(fixture.assignment, fixture.options)
  // Attach rejection handling before revoking or releasing any paused boundary.
  const rejected = expect(starting).rejects.toThrow('subscription_hosted_runtime_unavailable')
  void rejected.catch(() => undefined)
  try {
    await bounded(entered.promise, 'trusted context pause')
    fixture.gate.revoke()
    resume.resolve()
    await rejected
    expect(fixture.processes()).toEqual([])
    expect(fixture.socket()).toBeUndefined()
    expect(fixture.link.nativeRequest).not.toHaveBeenCalled()
    const calls = fixture.link.nativeContext.mock.calls.length
    await expect(fixture.runner.start(fixture.assignment, fixture.options)).rejects.toThrow('Run tool approval unavailable')
    expect(fixture.link.nativeContext).toHaveBeenCalledTimes(calls)
  } finally {
    fixture.gate.revoke(); resume.resolve()
    await starting.catch(() => undefined)
  }
}, 60000)

it('a CLI that cannot start keeps its reason, leaves nothing running, and the next runner starts', async () => {
  const broken = join(mkdtempSync(join(tmpdir(), 'mikka-hosted-broken-')), 'claude')
  writeFileSync(broken, `#!${process.execPath}\nprocess.exit(3)\n`, { mode: 0o700 })
  const fixture = await revocationFixture(broken)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const error = await (async () => {
      const session = await fixture.runner.start(fixture.assignment, fixture.options)
      // An adapter may hand back a session whose CLI already ended; then the
      // failure is its last event.
      const events = []
      for await (const event of session.events()) events.push(event)
      return events.at(-1)
    })().then(last => ({ last }), (e: Error) => ({ error: e }))
    if ('error' in error) {
      expect(error.error.message).toBe('claude_code_initialization_failed')
      expect((error.error.cause as Error | undefined)?.message).toBe('Claude Code initialization failed')
      expect(warn.mock.calls.some(call => String(call[0]).includes('hosted CLI did not start'))).toBe(true)
    } else {
      expect(error.last).toMatchObject({ type: 'exit' })
      expect((error.last as { outcome?: string }).outcome).not.toBe('succeeded')
    }
    await waitFor(() => fixture.processes().length === 0)
    expect(fixture.socket()).toBeUndefined()
    // A restarted daemon on the same machine is not blocked by this run.
    await expect(fixture.open()).resolves.toBeDefined()
  } finally {
    warn.mockRestore()
    fixture.gate.revoke()
  }
}, 60000)

it('startup is not blocked by container records an earlier, Docker-based worker left', async () => {
  const fixture = await revocationFixture()
  const resources = join(fixture.stateDir, 'native-resources')
  mkdirSync(resources, { recursive: true })
  writeFileSync(join(resources, `mikka-native-${randomUUID()}.json`), JSON.stringify({ name: 'mikka-native-x', nonce: randomUUID(), state: 'creating' }))
  writeFileSync(join(resources, `mikka-native-${randomUUID()}.json`), JSON.stringify({ name: 'mikka-native-y', nonce: randomUUID(), state: 'created', id: 'a'.repeat(64) }))
  await expect(fixture.open()).resolves.toBeDefined()
  expect(existsSync(resources)).toBe(false)
}, 60000)

it.each(['pending', 'streaming'] as const)('revokes a hosted CLI on the machine and %s synthetic provider transport when CLI policy expires', async phase => {
  const fixture = await revocationFixture()
  const entered = deferred<AbortSignal>(), chunk = deferred<void>(), aborted = deferred<void>()
  fixture.link.nativeRequest.mockImplementation(async (_device, _run, _payload, signal) => {
    if (!signal) throw new Error('broker abort signal required')
    entered.resolve(signal)
    if (phase === 'pending') return new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted.resolve(); reject(new Error('synthetic provider cancelled')) }, { once: true })
    })
    return { contentType: 'text/event-stream', body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: synthetic-only\n\n'))
        signal.addEventListener('abort', () => { aborted.resolve(); controller.error(new Error('synthetic stream cancelled')) }, { once: true })
      },
    }) }
  })
  let session: AgentSession | undefined
  let transport: ReturnType<typeof request> | undefined
  // Host secrets in the worker's own environment never reach the CLI: the
  // fixture CLI exits at once when it sees one.
  const hostSecrets = { E2B_API_KEY: 'fixture-host-secret', INFISICAL_CLIENT_SECRET: 'fixture-host-secret' }
  const saved = Object.fromEntries(Object.keys(hostSecrets).map(key => [key, process.env[key]]))
  Object.assign(process.env, hostSecrets)
  try {
    session = await fixture.runner.start(fixture.assignment, fixture.options)
    const finished = (async () => { const events = []; for await (const event of session!.events()) events.push(event); return events })()
    void finished.catch(() => undefined)
    // The CLI runs as this worker's own user, in its own process group, and
    // nothing of it carries a Docker socket.
    const running = await waitFor(() => { const list = fixture.processes(); return list.length >= 2 ? list : undefined })
    for (const line of running) {
      const pid = Number(line.split(' ', 1)[0])
      expect(Number(execFileSync('ps', ['-o', 'uid=', '-p', String(pid)], { encoding: 'utf8' }).trim())).toBe(process.getuid!())
      expect(readFileSync(`/proc/${pid}/environ`, 'utf8')).not.toMatch(/DOCKER_HOST|fixture-host-secret/)
    }
    const brokerSocket = fixture.socket()!
    const transportClosed = new Promise<void>(resolveClosed => {
      // This is a host test request to the real run-private broker. The CLI is
      // the existing synthetic HANG fixture; no account/provider is contacted.
      transport = request({ socketPath: brokerSocket, method: 'POST', path: '/v1/messages' }, response => {
        response.on('data', () => chunk.resolve())
        response.on('error', () => resolveClosed())
        response.on('close', resolveClosed)
      })
      transport.on('error', () => resolveClosed())
      transport.end(JSON.stringify({ model: 'fixture-model', messages: [] }))
    })
    const signal = await bounded(entered.promise, 'synthetic provider entry')
    if (phase === 'streaming') await bounded(chunk.promise, 'synthetic provider streaming')
    // Keep nativeContext unchanged: the CLI policy gate is the authority that
    // must stop the run, even without a subscription-revision change.
    fixture.revokePolicy()
    await waitFor(() => fixture.gate.revoked)
    await bounded(aborted.promise, 'synthetic provider abort')
    expect(signal.aborted).toBe(true)
    await bounded(transportClosed, 'native broker transport close')
    await bounded(finished, 'owned CLI exit')
    // The whole process group is gone: bootstrap, CLI and its children.
    await waitFor(() => fixture.processes().length === 0)
    await waitFor(() => !existsSync(brokerSocket))
    const forwarded = fixture.link.nativeRequest.mock.calls.length
    const lateRefused = await new Promise<boolean>(resolveRefused => {
      const late = request({ socketPath: brokerSocket, method: 'POST', path: '/v1/messages' }, response => { response.resume(); resolveRefused(false) })
      late.on('error', () => resolveRefused(true))
      late.end(JSON.stringify({ model: 'fixture-model', messages: [] }))
    })
    expect(lateRefused).toBe(true)
    await expect(session.send('late work')).rejects.toThrow('subscription_hosted_runtime_unavailable')
    await expect(fixture.runner.start(fixture.assignment, fixture.options)).rejects.toThrow('Run tool approval unavailable')
    expect(fixture.link.nativeRequest).toHaveBeenCalledTimes(forwarded)
    expect(fixture.processes()).toEqual([])
    writeFileSync(join(fixture.root, 'evidence.json'), JSON.stringify({ classification: 'process groups on this machine; synthetic CLI and provider stream', phase, processes: running, forwarded, signalAborted: signal.aborted }, null, 2))
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fixture.gate.revoke()
    transport?.destroy()
    await session?.cancel()
  }
}, 60000)

it('retains a post-start subscription context refusal while stopping the real CLI without private values', async () => {
  const fixture = await revocationFixture()
  const log = vi.spyOn(fixture.options.log, 'warn').mockImplementation(() => {})
  let session: AgentSession | undefined
  try {
    session = await fixture.runner.start(fixture.assignment, fixture.options)
    const finished = (async () => { const events = []; for await (const event of session!.events()) events.push(event); return events })()
    fixture.contextValue.accountId = 'private-runtime-account-must-not-log'
    await finished
    const records = log.mock.calls.map(call => call[0] as unknown as { event?: string })
    expect(records.filter(record => record.event === 'subscription_runtime_failed')).toHaveLength(1)
    expect(records.find(record => record.event === 'subscription_runtime_failed')).toMatchObject({ phase: 'context_check', sameAccount: false, reason: 'context_changed' })
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-runtime-account|fixture-account/)
    expect(fixture.processes()).toEqual([])
  } finally { fixture.gate.revoke(); await session?.cancel(); log.mockRestore() }
}, 45000)

it('recovers a transient post-start context outage before admitting another native send', async () => {
  const fixture = await revocationFixture()
  const log = vi.spyOn(fixture.options.log, 'warn').mockImplementation(() => {})
  let session: AgentSession | undefined
  try {
    session = await fixture.runner.start(fixture.assignment, fixture.options)
    let attempts = 0
    fixture.link.nativeContext.mockImplementation(async () => {
      if (++attempts === 1) throw new ServerUnreachableError(503)
      return fixture.contextValue
    })
    await session.send('HANG')
    // The adapter independently verifies the admitted send as well.
    expect(attempts).toBeGreaterThanOrEqual(2)
    expect(fixture.processes().length).toBeGreaterThan(0)
    expect(fixture.link.nativeRequest).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  } finally { fixture.gate.revoke(); await session?.cancel(); log.mockRestore() }
}, 45000)

it('blocks a broker request until fresh authority succeeds after a transient context outage', async () => {
  const fixture = await revocationFixture()
  let session: AgentSession | undefined
  let transport: ReturnType<typeof request> | undefined
  const resume = deferred<void>()
  try {
    session = await fixture.runner.start(fixture.assignment, fixture.options)
    const checking = deferred<void>()
    let attempts = 0
    fixture.link.nativeContext.mockImplementation(async () => {
      if (++attempts === 1) throw new ServerUnreachableError(503)
      checking.resolve()
      await resume.promise
      return fixture.contextValue
    })
    fixture.link.nativeRequest.mockImplementation(async () => ({ contentType: 'application/json', body: new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"content":[]}'))
      controller.close()
    } }) }))
    const response = new Promise<string>((resolveResponse, reject) => {
      transport = request({ socketPath: fixture.socket()!, method: 'POST', path: '/v1/messages' }, reply => {
        let body = ''
        reply.on('data', chunk => { body += chunk })
        reply.on('end', () => resolveResponse(body))
        reply.on('error', reject)
      })
      transport.on('error', reject)
      transport.end(JSON.stringify({ model: 'fixture-model', messages: [] }))
    })
    await bounded(checking.promise, 'fresh authority pending')
    expect(fixture.link.nativeRequest).not.toHaveBeenCalled()
    resume.resolve()
    expect(await bounded(response, 'authorized broker response')).toBe('{"content":[]}')
    expect(fixture.link.nativeRequest).toHaveBeenCalledTimes(1)
  } finally { resume.resolve(); fixture.gate.revoke(); transport?.destroy(); await session?.cancel() }
}, 45000)

it.each([
  ['persistent outage', () => new ServerUnreachableError(503), 3],
  ['authoritative refusal', () => new DaemonError(-32603, 'refused', { status: 409 }), 1],
] as const)('stops the real hosted CLI after %s without forwarding provider work', async (_label, failure, expectedAttempts) => {
  const fixture = await revocationFixture()
  const log = vi.spyOn(fixture.options.log, 'warn').mockImplementation(() => {})
  let session: AgentSession | undefined
  try {
    session = await fixture.runner.start(fixture.assignment, fixture.options)
    let attempts = 0
    fixture.link.nativeContext.mockImplementation(async () => { attempts++; throw failure() })
    const finished = (async () => { for await (const _event of session!.events()) { /* drain actual process exit */ } })()
    await bounded(finished, 'context refusal closes CLI')
    expect(attempts).toBe(expectedAttempts)
    expect(fixture.processes()).toEqual([])
    expect(fixture.link.nativeRequest).not.toHaveBeenCalled()
    const records = log.mock.calls.map(call => call[0] as unknown as { event?: string })
    expect(records.filter(record => record.event === 'subscription_runtime_failed')).toHaveLength(1)
  } finally { fixture.gate.revoke(); await session?.cancel(); log.mockRestore() }
}, 45000)

it('revokes during context retry backoff without another authority request or provider call', async () => {
  const fixture = await revocationFixture()
  let session: AgentSession | undefined
  try {
    session = await fixture.runner.start(fixture.assignment, fixture.options)
    const entered = deferred<void>()
    let attempts = 0
    fixture.link.nativeContext.mockImplementation(async () => {
      attempts++; entered.resolve(); throw new ServerUnreachableError(503)
    })
    const finished = (async () => { for await (const _event of session!.events()) { /* drain actual process exit */ } })()
    await bounded(entered.promise, 'first context outage')
    await new Promise(resolve => setTimeout(resolve, 50))
    fixture.gate.revoke()
    await bounded(finished, 'revoked retry closes CLI')
    expect(attempts).toBe(1)
    expect(fixture.link.nativeRequest).not.toHaveBeenCalled()
    expect(fixture.processes()).toEqual([])
  } finally { fixture.gate.revoke(); await session?.cancel() }
}, 45000)

it.each(['expired', 'invalid'] as const)('rejects a successful but %s post-start context without retry', async kind => {
  const fixture = await revocationFixture()
  let session: AgentSession | undefined
  try {
    session = await fixture.runner.start(fixture.assignment, fixture.options)
    let attempts = 0
    fixture.link.nativeContext.mockImplementation(async () => {
      attempts++
      return { ...fixture.contextValue, expiresAt: kind === 'expired' ? new Date(Date.now() - 1000).toISOString() : 'invalid' }
    })
    await expect(session.send('HANG')).rejects.toThrow('subscription_hosted_runtime_unavailable')
    expect(attempts).toBe(1)
    expect(fixture.link.nativeRequest).not.toHaveBeenCalled()
  } finally { fixture.gate.revoke(); await session?.cancel() }
}, 45000)

it.each(['token', 'verify'] as const)('logs finite startup diagnostics for a refusal during %s without private values', async phase => {
  const fixture = await revocationFixture()
  const log = vi.spyOn(fixture.options.log, 'warn').mockImplementation(() => {})
  const consoleLog = vi.spyOn(console, 'warn').mockImplementation(() => {})
  fixture.link.nativeContext.mockImplementation(async () => {
    if (fixture.link.nativeContext.mock.calls.length === (phase === 'token' ? 3 : 4)) {
      if (phase === 'token') throw new DaemonError(-32603, 'private-upstream-token-must-not-log', { status: 409, credential: 'private-credential-must-not-log' })
      return { ...fixture.contextValue, accountId: 'private-account-must-not-log' }
    }
    return fixture.contextValue
  })
  try {
    await expect(fixture.runner.start(fixture.assignment, fixture.options)).rejects.toThrow('subscription_hosted_runtime_unavailable')
    const records = log.mock.calls.map(call => call[0] as unknown as { event?: string })
    expect(records.filter(record => record.event === 'subscription_startup_failed')).toHaveLength(1)
    expect(records.find(record => record.event === 'subscription_startup_failed')).toMatchObject({ event: 'subscription_startup_failed', phase, contextReady: true, brokerReady: true, tokenRequested: true,
      ...(phase === 'token' ? { reason: 'server_refused', httpStatus: 409, tokenCheckPassed: false } : { reason: 'context_changed', tokenCheckPassed: true, verifyRequested: true, verifyCheckPassed: false, sameAccount: false }) })
    const encoded = JSON.stringify(log.mock.calls)
    for (const privateValue of ['private-upstream-token', 'private-credential', 'private-account', 'fixture-account']) expect(encoded).not.toContain(privateValue)
    expect(fixture.processes()).toEqual([])
    expect(fixture.link.nativeRequest).not.toHaveBeenCalled()
  } finally {
    fixture.gate.revoke()
    log.mockRestore()
    consoleLog.mockRestore()
  }
})

it('reports a hung hosted Claude initializer as startup timeout and closes its entire runtime', async () => {
  const binary = join(tempDir('mnh-init-timeout-'), 'claude')
  writeFileSync(binary, '#!/bin/sh\nexec sleep 60\n', { mode: 0o700 })
  const fixture = await revocationFixture(binary)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await expect(fixture.runner.start(fixture.assignment, fixture.options)).rejects.toMatchObject({
      message: 'claude_code_initialization_timeout',
      cause: { name: 'ClaudeInitializationError', message: 'Claude Code initialization timed out' },
    })
    expect(fixture.link.nativeRequest).not.toHaveBeenCalled()
    expect(fixture.processes()).toEqual([])
    expect(fixture.socket()).toBeUndefined()
    expect(fixture.gate.revoked).toBe(true)
  } finally { fixture.gate.revoke(); warn.mockRestore() }
})

it('rechecks the owned Codex broker account before the first custom-provider turn', async () => {
  const fixture = await revocationFixture('fakes/fake-codex-subscription.mjs', 'codex')
  const log = vi.spyOn(fixture.options.log, 'warn').mockImplementation(() => {})
  const consoleLog = vi.spyOn(console, 'warn').mockImplementation(() => {})
  fixture.link.nativeContext.mockImplementation(async () => fixture.link.nativeContext.mock.calls.length === 4
    ? { ...fixture.contextValue, accountId: 'another-account' } : fixture.contextValue)
  try {
    await expect(fixture.runner.start(fixture.assignment, fixture.options)).rejects.toThrow('subscription_hosted_runtime_unavailable')
    expect(log.mock.calls[0][0]).toMatchObject({ phase: 'verify', reason: 'context_changed', tokenRequested: false, verifyRequested: true, verifyCheckPassed: false, sameAccount: false })
    expect(fixture.link.nativeRequest).not.toHaveBeenCalled()
    expect(fixture.processes()).toEqual([])
  } finally { fixture.gate.revoke(); log.mockRestore(); consoleLog.mockRestore() }
})

it.each([true, false])('advertises hosted approval capability only with a prepared host gate factory: %s', async available => {
  const fixture = await revocationFixture()
  fixture.link.prepareRunToolApproval = available ? async assignment => denyGate(assignment.runId) : undefined
  const registered = vi.spyOn(fixture.link, 'registerDevice')
  const daemon = new Daemon({ dataDir: join(fixture.root, 'daemon'), flavor: 'dev', link: fixture.link, credential: 'synthetic-device', hostedSubscriptions: true,
    harnessBinaries: { claude_code: fixture.binary }, quotaSource: null, log: createLogger({ level: 'silent' }),
    ...(process.env.MIKKA_E2B_TEST_DOCKER === '1' ? { e2bContainerRuntime: true } : {}),
  })
  try {
    await daemon.start()
    await daemon.syncWithServer()
    const advertised = registered.mock.calls.at(-1)?.[1].harnesses.find(info => info.harness === 'claude_code')
    expect(advertised?.installed).toBe(true)
    expect(advertised?.subscriptionBroker).toBe(true)
    expect(advertised?.toolApproval).toBe(available ? true : undefined)
    expect(fixture.processes()).toEqual([])
    expect(fixture.link.nativeRequest).not.toHaveBeenCalled()
  } finally { await daemon.stop() }
}, 60000)

// Production (Acme): a thread's continuation was frozen with model null while its subscription context
// was claude-opus-5-5, and the runner refused it at once (context_initial, sameModel=false,
// reason=context_changed). The server now freezes every cloud run with its subscription's model.
it.each([
  ['the model the bug froze (none)', undefined, false],
  ['the subscription\'s own model, as the fix freezes it', 'claude-opus-5-5', true],
] as const)('a hosted claude_code run with %s', async (_label, model, starts) => {
  const root = tempDir('mnh-model-'), stateDir = join(root, 'adapters')
  mkdirSync(stateDir)
  const runId = randomUUID(), deviceId = randomUUID()
  const link = Object.assign(new MemoryServer(deviceId).link(), {
    nativeContext: async () => ({ route: 'claude_code_cli' as const, modelId: 'claude-opus-5-5', revision: 2, accountId: 'fixture-account', expiresAt: new Date(Date.now() + 60000).toISOString() }),
    nativeRequest: async () => { throw new Error('fixture must not call provider') },
  })
  const binary = resolve(import.meta.dirname, 'fakes/fake-claude-subscription.mjs')
  chmodSync(binary, 0o700)
  const runner = await createHostedBotRunner({ stateDir, link, binaries: { claude_code: binary },
    ...(process.env.MIKKA_E2B_TEST_DOCKER === '1' ? { dockerSocket: 'unix:///run/mikka-container/docker.sock' as const } : {}) })
  const assignment = { runId, deviceId, issueId: randomUUID(), repoId: randomUUID(), baseBranch: 'main', harness: 'claude_code', prompt: 'hello', ...(model ? { model } : {}),
    subscriptionBinding: { bindingId: randomUUID(), ownerId: 'fixture-owner', workspaceId: randomUUID(), consumerId: randomUUID(), route: 'claude_code_cli' },
  } as RunAssignment
  const started = runner.start(assignment, { runId, toolApproval: denyGate(runId), cwd: await makeRepo(), prompt: 'hello', ...(model ? { model } : {}), env: buildChildEnv({ host: { PATH: process.env.PATH, HOME: tempDir() } }), log: createLogger({ level: 'silent' }) })
  if (!starts) {
    await expect(started).rejects.toThrow('subscription_hosted_runtime_unavailable')
    return
  }
  const session = await started
  const events = []
  for await (const event of session.events()) events.push(event)
  expect(events.at(-1)).toMatchObject({ type: 'exit', outcome: 'succeeded' })
}, 60000)

it('starts a subscription run only on a model the machine\'s own CLI reported, and fails with the reason otherwise', async () => {
  const fixture = await revocationFixture()
  let report: { models?: string[]; modelSlots?: { slot: string; model: string; name: string }[] } | null = { models: ['another-model'] }
  const reportedModels = vi.fn(async () => report)
  const runner = await createHostedBotRunner({ stateDir: fixture.stateDir, link: fixture.link, binaries: { claude_code: fixture.binary }, reportedModels })
  // Reported other models only, or none at all (a probe that got no answer): refused before any context, broker or CLI.
  for (const value of [{ models: ['another-model'] }, null, {}]) {
    report = value
    await expect(runner.start(fixture.assignment, fixture.options)).rejects.toThrow('subscription_model_not_reported')
  }
  expect(reportedModels).toHaveBeenCalledWith('claude_code')
  expect(fixture.link.nativeContext).not.toHaveBeenCalled()
  expect(fixture.processes()).toEqual([])
  // Reported as a slot's resolved model: the model check passes and startup goes on (here to a refused context).
  report = { modelSlots: [{ slot: 'opus', model: 'fixture-model', name: 'Opus' }] }
  fixture.link.nativeContext.mockImplementation(async () => { throw new Error('fixture context refused') })
  await expect(runner.start(fixture.assignment, fixture.options)).rejects.toThrow('fixture context refused')
  expect(fixture.link.nativeContext).toHaveBeenCalled()
})
