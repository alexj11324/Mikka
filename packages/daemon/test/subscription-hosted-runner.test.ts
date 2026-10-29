import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { request } from "node:http";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { defaultRunPolicy, type RunAssignment } from "@mikka/protocol";
import { createHostedBotRunner } from "../src/subscription-hosted-runner";
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
  it(`runs ${harness} through the existing adapter in a private Docker runtime and retains the owner session ledger`, async () => {
    const root = tempDir("mnh-");
    const stateDir = join(root, "adapters");
    mkdirSync(stateDir);
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
      toolApproval: new ToolApprovalGate(runId, { permission: () => 'deny', ask: async () => 'deny', isLive: () => true }),
      cwd: await makeRepo(),
      prompt: "PROBE_GIT",
      model: "fixture-model",
      env: buildChildEnv({ host: { PATH: process.env.PATH, HOME: tempDir() } }),
      log: createLogger({ level: "silent" }),
    };
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
    connected = false;
    // Completed sessions revoke their own gate. A restart needs a fresh host
    // gate before the independently revoked subscription context is consulted.
    options.toolApproval = denyGate(runId);
    await expect(runner.start(assignment, options)).rejects.toThrow("revoked");
    const verify = await runner.command(
      options.cwd,
      'test -z "$E2B_API_KEY$INFISICAL_CLIENT_SECRET" && ! (printf blocked > .git/guard) 2>/dev/null && printf allowed > project-probe',
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
  return new ToolApprovalGate(runId, { permission: () => 'deny', ask: async () => 'deny', isLive: live })
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
const dockerExec = promisify(execFile)

// These fixtures use real Docker isolation and synthetic CLI/auth/provider
// protocol only. The trusted command wrapper forwards every Docker operation;
// it can withhold a *real successful create's stdout* to expose the ownership
// race deterministically. No production liveness or container result is faked.
async function revocationFixture(holdCreate = false) {
  // Keep audit files outside the shared disposable-directory helper. Its
  // independent owner may recycle fixtures; these records must stay retained.
  const root = mkdtempSync(join(tmpdir(),'mikka-hosted-approval-')), stateDir = join(root, 'adapters')
  console.info(`Retained hosted approval audit: ${root}`)
  mkdirSync(stateDir)
  const realDocker = execFileSync('/bin/sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim()
  const bin = join(root, 'bin'), calls = join(root, 'docker.jsonl'), created = join(root, 'created-id'), release = join(root, 'release-create')
  mkdirSync(bin)
  writeFileSync(join(bin, 'docker'), `#!${process.execPath}
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({at:new Date().toISOString(),args})+'\\n');
const creating = args[0] === 'create';
const child = spawn(${JSON.stringify(realDocker)}, args, { stdio: ['inherit', creating ? 'pipe' : 'inherit', 'inherit'] });
let output = '';
if (creating) child.stdout.on('data', part => { output += part });
else for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', error => { process.stderr.write(error.message); process.exitCode = 1 });
child.on('close', async code => {
  if (creating && code === 0) {
    writeFileSync(${JSON.stringify(created)}, output.trim());
    if (${holdCreate}) while (!existsSync(${JSON.stringify(release)})) await new Promise(done => setTimeout(done, 25));
  }
  if (creating) process.stdout.write(output);
  process.exitCode = code ?? 1;
});
`, { mode: 0o700 })
  const dockerEnv = { PATH: process.env.PATH, ...(process.env.MIKKA_E2B_TEST_DOCKER === '1' ? { DOCKER_HOST: 'unix:///run/mikka-container/docker.sock' } : {}) }
  const runId = randomUUID(), deviceId = randomUUID()
  const contextValue = { route: 'claude_code_cli' as const, modelId: 'fixture-model', revision: 2, accountId: 'fixture-account', expiresAt: new Date(Date.now() + 60000).toISOString() }
  const link = Object.assign(new MemoryServer(deviceId).link(), {
    nativeContext: vi.fn(async (_device: string, _run: string, _signal?: AbortSignal) => contextValue),
    nativeRequest: vi.fn(async (_device: string, _run: string, _payload: unknown, _signal?: AbortSignal): Promise<{ contentType: string; body: ReadableStream<Uint8Array> }> => { throw new Error('no real provider in hosted fixture') }),
  })
  const binary = resolve(import.meta.dirname, 'fakes/fake-claude-subscription.mjs')
  chmodSync(binary, 0o700)
  const previousPath = process.env.PATH
  let runner: Awaited<ReturnType<typeof createHostedBotRunner>>
  try {
    process.env.PATH = `${bin}:${previousPath ?? '/usr/bin:/bin'}`
    runner = await createHostedBotRunner({ stateDir, link, binaries: { claude_code: binary }, ...(process.env.MIKKA_E2B_TEST_DOCKER === '1' ? { dockerSocket: 'unix:///run/mikka-container/docker.sock' as const } : {}) })
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
  }
  const assignment = { runId, deviceId, issueId: randomUUID(), repoId: randomUUID(), baseBranch: 'main', harness: 'claude_code', prompt: 'HANG', model: 'fixture-model',
    subscriptionBinding: { bindingId: randomUUID(), ownerId: 'fixture-owner', workspaceId: randomUUID(), consumerId: randomUUID(), route: 'claude_code_cli' },
  } as RunAssignment
  let policyLive = true
  const gate = denyGate(runId, () => policyLive)
  const options = { runId, toolApproval: gate, cwd: await makeRepo(), prompt: 'HANG', model: 'fixture-model', env: buildChildEnv({ host: { PATH: process.env.PATH, HOME: tempDir() } }), log: createLogger({ level: 'silent' }) }
  const commands = (): string[][] => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).args) : []
  const socket = () => {
    const brokers = join(stateDir, 'native-brokers')
    if (!existsSync(brokers)) return undefined
    return readdirSync(brokers).map(name => join(brokers, name, 'broker.sock')).find(path => existsSync(path))
  }
  const resource = () => {
    const files = readdirSync(join(stateDir, 'native-resources'))
    return files[0] ? JSON.parse(readFileSync(join(stateDir, 'native-resources', files[0]), 'utf8')) as { name: string; id?: string; nonce: string; state: string } : undefined
  }
  async function gone(id: string) {
    await waitFor(async () => {
      try { await dockerExec(realDocker, ['inspect', id], { env: dockerEnv }); return false }
      catch (error) {
        expect(String((error as { stderr: string }).stderr)).toMatch(/No such (?:container|object)/i)
        return true
      }
    })
  }
  return { root, stateDir, runId, runner, link, assignment, options, gate, contextValue, binary, created, release, commands, socket, resource, gone,
    revokePolicy: () => { policyLive = false },
    inspect: async (id: string) => JSON.parse((await dockerExec(realDocker, ['inspect', id], { env: dockerEnv })).stdout)[0],
  }
}

it.each(['context', 'broker', 'create'] as const)('fences hosted startup revoked during %s and removes only its settled Docker resource', async phase => {
  const fixture = await revocationFixture(phase === 'create')
  const entered = deferred<void>(), resume = deferred<void>()
  if (phase === 'context') {
    await expect(fixture.runner.start(fixture.assignment, { ...fixture.options, toolApproval: undefined })).rejects.toThrow('Run tool approval unavailable')
    await expect(fixture.runner.start(fixture.assignment, { ...fixture.options, toolApproval: denyGate(randomUUID()) })).rejects.toThrow('Run tool approval unavailable')
    const stopped = denyGate(fixture.runId); stopped.revoke()
    await expect(fixture.runner.start(fixture.assignment, { ...fixture.options, toolApproval: stopped })).rejects.toThrow('Run tool approval unavailable')
    expect(fixture.link.nativeContext).not.toHaveBeenCalled()
  }
  if (phase !== 'create') fixture.link.nativeContext.mockImplementation(async () => {
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
    if (phase === 'create') await waitFor(() => existsSync(fixture.created))
    else await bounded(entered.promise, 'trusted context pause')
    const record = fixture.resource()
    const brokerSocket = fixture.socket()
    fixture.gate.revoke()
    if (phase === 'create') {
      expect(record).toMatchObject({ state: 'creating' })
      expect(brokerSocket).toBeDefined()
      await waitFor(() => !existsSync(brokerSocket!))
      // Create has really succeeded, but its stdout is still held. Revocation
      // must not claim removal before that pending create outcome settles.
      const actualId = readFileSync(fixture.created, 'utf8')
      expect((await fixture.inspect(actualId)).State.Running).toBe(false)
      writeFileSync(fixture.release, 'release owned create result')
      await rejected
      await fixture.gone(actualId)
      expect(fixture.commands().filter(args => args[0] === 'rm')).toEqual([['rm', '-f', actualId]])
    } else {
      resume.resolve()
      await rejected
      expect(fixture.commands().some(args => args[0] === 'create')).toBe(false)
    }
    expect(fixture.commands().some(args => args[0] === 'start')).toBe(false)
    expect(fixture.resource()).toBeUndefined()
    expect(fixture.socket()).toBeUndefined()
    expect(fixture.link.nativeRequest).not.toHaveBeenCalled()
    const calls = fixture.link.nativeContext.mock.calls.length
    await expect(fixture.runner.start(fixture.assignment, fixture.options)).rejects.toThrow('Run tool approval unavailable')
    expect(fixture.link.nativeContext).toHaveBeenCalledTimes(calls)
  } finally {
    fixture.gate.revoke(); resume.resolve()
    writeFileSync(fixture.release, 'release on fixture teardown')
    await starting.catch(() => undefined)
  }
}, 60000)

it.each(['pending', 'streaming'] as const)('revokes a real Docker hosted CLI and %s synthetic provider transport when CLI policy expires', async phase => {
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
  try {
    session = await fixture.runner.start(fixture.assignment, fixture.options)
    const finished = (async () => { const events = []; for await (const event of session!.events()) events.push(event); return events })()
    void finished.catch(() => undefined)
    const record = fixture.resource()!
    expect(record.state).toBe('created')
    const actual = await fixture.inspect(record.id!)
    expect(actual.HostConfig.NetworkMode).toBe('none')
    expect(actual.HostConfig.ReadonlyRootfs).toBe(true)
    expect(actual.HostConfig.CapDrop).toContain('ALL')
    expect(actual.HostConfig.SecurityOpt).toContain('no-new-privileges')
    expect(actual.Config.User).toBe(`${process.getuid!()}:${process.getgid!()}`)
    expect(actual.Config.Labels['com.mikka.native.resource']).toBe(record.nonce)
    expect(actual.Mounts.some((mount: { Destination: string }) => mount.Destination.endsWith('/docker.sock'))).toBe(false)
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
    await bounded(finished, 'owned Docker CLI exit')
    await fixture.gone(record.id!)
    await waitFor(() => !existsSync(brokerSocket))
    expect(fixture.resource()).toBeUndefined()
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
    expect(fixture.commands().filter(args => args[0] === 'start')).toHaveLength(1)
    expect(fixture.commands().filter(args => args[0] === 'rm')).toEqual([['rm', '-f', record.id]])
    writeFileSync(join(fixture.root, 'evidence.json'), JSON.stringify({ classification: 'real Docker; synthetic CLI and provider stream', phase, resource: record, container: actual, commands: fixture.commands(), forwarded, signalAborted: signal.aborted }, null, 2))
  } finally {
    fixture.gate.revoke()
    transport?.destroy()
    await session?.cancel()
  }
}, 60000)

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
    expect(fixture.commands().some(args => args[0] === 'create')).toBe(false)
    expect(fixture.link.nativeRequest).not.toHaveBeenCalled()
  } finally { await daemon.stop() }
}, 60000)
