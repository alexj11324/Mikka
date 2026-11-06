import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { streamText, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import { SubscriptionService } from '../../lib/subscription-service'
import type { SubscriptionRepository } from '../../lib/subscription-repository'
import { SubscriptionWorkerClient } from '../../packages/daemon/src/subscription-worker-client'
import { startMvpServices } from './services.mjs'
import { MVP_SERVICES,REPOSITORY } from './isolated-env.mjs'
import { MVP_NATIVE_ACCOUNT, MVP_NATIVE_TOKEN, MVP_SUBSCRIPTION_MODEL } from './subscription.mjs'
import { createTraceCodexBinary, createTraceGitHubBinary, checkTracePrerequisites, traceGitCommand } from './trace-codex.mjs'
import { preflightLocalSubscription } from '../../packages/daemon/src/subscription-preflight'
import { HARNESS_PINS } from '../../packages/daemon/src/harness-install'
import { answerModel, tracePublicationReady } from './model.mjs'

test('trace subscription fixture supports the current catalogue and native lease ABI, scoped to a run', async () => {
  const config = { scope: { ownerId: 'mvp-owner', workspaceId: randomUUID(), connectionId: randomUUID(), provider: 'codex' as const },
    databaseUrl: 'postgresql://ci:fixture@127.0.0.1:5432/mikka_e2e', infisicalOrigin: MVP_SERVICES,
    project: 'mvp-synthetic', environment: 'test', path: '/custody', workloadToken: 'mvp-synthetic-custody', accessPath: '/access', accessToken: 'mvp-synthetic-access' }
  const launch = { binary: fileURLToPath(new URL('./subscription-worker.mjs', import.meta.url)) }
  const worker = new SubscriptionWorkerClient(launch, config)
  assert.deepEqual(await worker.call('models', { revision: 1 }), [{ id: MVP_SUBSCRIPTION_MODEL, name: 'Synthetic trace model' }])
  assert.equal((await worker.call<{ status: number }>('usage', { revision: 1 })).status, 200)
  await assert.rejects(worker.call('nativeContext', { revision: 1 }), { code: 'subscription_fixture_refused' })
  const use = { bindingId: randomUUID(), consumerId: randomUUID(), runId: randomUUID() }
  const scoped = worker.forUse(use)
  const context = await scoped.call<{ accountId: string; expiresAt: string }>('nativeContext', { revision: 1 })
  assert.equal(context.accountId, MVP_NATIVE_ACCOUNT)
  assert.ok(Date.parse(context.expiresAt) > Date.now())
  await assert.rejects(scoped.call('nativeAuth', { revision: 1 }), { code: 'subscription_fixture_refused' })
  const lease = await new SubscriptionWorkerClient(launch, { ...config, exportAccessLease: true }).forUse(use)
    .call<{ accessToken: string }>('nativeAuth', { revision: 1 })
  assert.equal(lease.accessToken, MVP_NATIVE_TOKEN)
  await assert.rejects(scoped.call('models', { revision: 2 }), { code: 'subscription_fixture_refused' })
})

test('trace Coordinator fixture chooses the source-bound Codex identity on the selected device', () => {
  const marker = `mvp-${randomUUID()}`, deviceId = randomUUID(), issueId = randomUUID(), agentId = randomUUID()
  const toolResult = (toolName: string, value: unknown) => ({ role: 'tool', content: [{ type: 'tool-result', toolName, output: { type: 'json', value } }] })
  const request = { prompt: [
    { role: 'user', content: `${marker}\nThe person selected device ${deviceId} in the task dialog.` },
    toolResult('create_issue', { id: issueId }),
    toolResult('list_agents', [{ id: randomUUID(), deviceId, harness: 'mock', deviceOnline: true },
      { id: randomUUID(), deviceId: randomUUID(), harness: 'codex', deviceOnline: true },
      { id: agentId, deviceId, harness: 'codex', deviceOnline: true }]),
  ], tools: [{ name: 'dispatch_run' }] }
  const answer = answerModel(request, { marker, deviceId, repo: REPOSITORY, harness: 'synthetic-codex' })
  assert.equal(answer.content[0].toolName, 'dispatch_run')
  assert.deepEqual(JSON.parse(answer.content[0].input), { issueId, agentId, repo: REPOSITORY })
})

test('trace completion accepts publication not yet observed while the execute publication gate stays pending', () => {
  const marker = `mvp-${randomUUID()}`, deviceId = randomUUID(), runId = randomUUID(), issueId = randomUUID()
  const observed: Record<string, unknown>[] = []
  const run = { id: runId, issueId, status: 'succeeded', summary: 'Synthetic task complete' }
  const request = { prompt: [
    { role: 'user', content: `${marker}\nThe person selected device ${deviceId} in the task dialog.` },
    { role: 'user', content: `[Event] Run ${runId} ended with status succeeded (submitted).` },
    { role: 'tool', content: [
      { type: 'tool-result', toolName: 'get_run', output: { type: 'json', value: run } },
      { type: 'tool-result', toolName: 'get_issue', output: { type: 'json', value: { id: issueId } } },
    ] },
  ] }
  const scenario = { marker, deviceId, repo: REPOSITORY, harness: 'synthetic-codex' }
  assert.match(answerModel(request, scenario, (value?: Record<string, unknown>) => { if (value) observed.push(value) }).content[0].text, /发布状态尚未确认/)
  assert.ok(!observed.some(value => value.pullRequest || value.kind === 'result'))
  assert.equal(tracePublicationReady(undefined), false)
  assert.equal(tracePublicationReady({ status: 'pending' }), false)
  assert.equal(tracePublicationReady({ status: 'published' }), true)
  assert.throws(() => tracePublicationReady({ status: 'blocked' }), /EXECUTION_PUBLICATION_FAILED/)
  assert.throws(() => answerModel(request, { ...scenario, harness: 'mock' }), /PR receipt/)
  run.id = randomUUID()
  assert.throws(() => answerModel(request, scenario), { code: 'MODEL_COMPLETION_MISMATCH' })
})

test('trace completion distinguishes a failed run detail from a refused get_run tool call', () => {
  const marker = `mvp-${randomUUID()}`, deviceId = randomUUID(), runId = randomUUID(), issueId = randomUUID()
  const scenario = { marker, deviceId, repo: REPOSITORY, harness: 'synthetic-codex' }
  const returned = (value: unknown) => ({ prompt: [
    { role: 'user', content: `${marker}\nThe person selected device ${deviceId} in the task dialog.` },
    { role: 'user', content: `[Event] Run ${runId} ended with status failed (error).` },
    { role: 'tool', content: [{ type: 'tool-result', toolName: 'get_run', output: { type: 'json', value } }] },
  ] })
  const answer = answerModel(returned({ id: runId, issueId, status: 'failed', error: 'private provider failure', summary: null }), scenario)
  assert.equal(answer.content[0].text, '线程已停止。')
  assert.ok(!JSON.stringify(answer).includes('private'))
  assert.throws(() => answerModel(returned({ error: 'runNotFound' }), scenario), { code: 'MODEL_RESULT_REFUSED', sourceCode: 'runNotFound' })
  assert.throws(() => answerModel(returned({ id: randomUUID(), issueId, status: 'failed', error: 'private provider failure' }), scenario), { code: 'MODEL_RESULT_REFUSED' })
})

test('trace synthetic Codex peer passes real version/model probes and requires synthetic auth before fixture turns', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-trace-peer-'))
  const fixture = join(directory, 'fixture.jsonl'), home = join(directory, 'home'), cwd = join(directory, 'worktree'), childTmp = join(directory, 'run-tmp')
  const mcp = join(directory, 'synthetic-submit.mjs'), submitted = join(directory, 'submitted.json')
  const services = await startMvpServices(3191)
  const scenario = await (await fetch(`${services.origin}/scenario`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ marker: `mvp-${randomUUID()}`, title: 'Synthetic native delivery', harness: 'synthetic-codex' }) })).json()
  await mkdir(home); await mkdir(cwd); await mkdir(childTmp)
  const git = (args: string[]) => traceGitCommand(scenario.barePath, cwd, args)
  await traceGitCommand(scenario.barePath, directory, ['clone', REPOSITORY, cwd])
  const originalBranch = await git(['branch', '--show-current'])
  const github = createTraceGitHubBinary(directory), bridge = join(directory, 'test-credential-bin')
  await mkdir(bridge)
  // This protocol test supplies a labelled synthetic credential wrapper. The
  // full chain uses the real authorized run-token exchange and run-local gh.
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  await writeFile(join(bridge, 'gh'), `#!/bin/sh\nGH_TOKEN=mvp-synthetic-installation-run exec ${quote(github)} "$@"\n`, { mode: 0o700 })
  await writeFile(fixture, JSON.stringify({ t: 0, exit: { outcome: 'failed', error: 'private-fixture-error' } }) + '\n')
  // This unit test has only a stdio peer. Full HTTP acceptance uses the real
  // Mikka MCP process, current run authority and durable handoff.
  await writeFile(mcp, `import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  if (request.id === undefined) continue
  if (request.method === 'tools/call') writeFileSync(${JSON.stringify(submitted)}, JSON.stringify(request.params))
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [], isError: false } }) + '\\n')
}`)
  const binary = createTraceCodexBinary(directory, fixture, scenario.barePath)
  try {
    const ready = await preflightLocalSubscription('codex', { store: { root: directory }, scratchDir: directory, binary })
    assert.deepEqual(ready, { ready: true, version: HARNESS_PINS.harnesses.codex.version })
    // The standalone daemon is typechecked in its own environment, without
    // the web app's global Next ProcessEnv augmentation. Load its probe here
    // through the runtime fixture boundary, as the daemon process does.
    const { probeHarnessModels } = await import(new URL('../../packages/daemon/src/model-probe.ts', import.meta.url).href)
    const report = await probeHarnessModels('codex', binary, { scratchDir: directory, timeoutMs: 5_000 })
    assert.deepEqual(report?.models, [MVP_SUBSCRIPTION_MODEL])
    const child = spawn(binary, ['app-server', '-c', `mcp_servers.mikka.command=${JSON.stringify(process.execPath)}`, '-c', `mcp_servers.mikka.args=${JSON.stringify([mcp])}`],
      // Match RunContext.tempEnv: its CLI-only TMPDIR differs from the host
      // root that owns the scenario's bare origin.
      { cwd, env: { PATH: `${bridge}${delimiter}${process.env.PATH ?? ''}`, HOME: home, CODEX_HOME: home, TMPDIR: childTmp, NODE_ENV: 'test' }, stdio: ['pipe', 'pipe', 'ignore'] })
    const output: Record<string, any>[] = []
    const lines = createInterface({ input: child.stdout })
    lines.on('line', line => output.push(JSON.parse(line)))
    const awaitMessage = async (find: (message: Record<string, any>) => boolean) => {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) { const value = output.find(find); if (value) return value; await delay(10) }
      assert.fail('SYNTHETIC_CODEX_RESPONSE_TIMEOUT')
    }
    let id = 0
    const request = (method: string, params: unknown = {}) => {
      const current = ++id
      child.stdin.write(JSON.stringify({ id: current, method, params }) + '\n')
      return awaitMessage(message => message.id === current)
    }
    try {
      assert.match((await request('initialize')).result.userAgent, /synthetic-trace-fixture/)
      assert.equal((await request('thread/start', { model: MVP_SUBSCRIPTION_MODEL, cwd })).error.code, -32603)
      assert.equal((await request('account/login/start', { type: 'chatgptAuthTokens', accessToken: 'incorrect', chatgptAccountId: MVP_NATIVE_ACCOUNT })).error.code, -32603)
      assert.equal((await request('account/login/start', { type: 'chatgptAuthTokens', accessToken: MVP_NATIVE_TOKEN, chatgptAccountId: MVP_NATIVE_ACCOUNT })).result.type, 'chatgptAuthTokens')
      const issueId = randomUUID(), branch = 'mikka/trace-fixture-1'
      const developerInstructions = `- You own delivery to https://github.com/mikka-e2e/core-loop. Keep the current local branch. Commit your tested work and push HEAD to ${branch} using the HTTPS repository URL. Never force-push.\n- Open or update the task pull request with gh, using head ${branch}. Its body must end with <!-- mikka-issue:${issueId} --> so Mikka can attach the result.`
      const started = (await request('thread/start', { model: MVP_SUBSCRIPTION_MODEL, cwd, developerInstructions })).result
      assert.equal(started.model, MVP_SUBSCRIPTION_MODEL)
      const turn = (await request('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'private prompt must not be read by fixture' }] })).result.turn.id
      const ended = await awaitMessage(message => message.method === 'turn/completed' && message.params.turn.id === turn)
      assert.equal(ended.params.turn.status, 'failed')
      assert.equal(ended.params.turn.error.message, 'private-fixture-error')
      const usage = output.find(message => message.method === 'thread/tokenUsage/updated')!
      assert.deepEqual(usage.params.tokenUsage.last, { inputTokens: 5, outputTokens: 2, cachedInputTokens: 1 })
      await assert.rejects(readFile(join(cwd, 'MIKKA_MOCK.md')), { code: 'ENOENT' })
      const submission = { summary: 'Synthetic change submitted', nextStep: 'Review this fixture' }
      await writeFile(fixture, [{ t: 0, write: { path: 'MIKKA_MOCK.md', content: 'synthetic change\n' } },
        { t: 1, submit: submission }, { t: 2, exit: { outcome: 'succeeded' } }].map(value => JSON.stringify(value)).join('\n') + '\n')
      const next = (await request('turn/start', { threadId: started.thread.id, input: [] })).result.turn.id
      assert.equal((await awaitMessage(message => message.method === 'turn/completed' && message.params.turn.id === next)).params.turn.status, 'completed')
      assert.equal(await readFile(join(cwd, 'MIKKA_MOCK.md'), 'utf8'), 'synthetic change\n')
      assert.deepEqual(JSON.parse(await readFile(submitted, 'utf8')), { name: 'submit', arguments: submission })
      const commit = await git(['rev-parse', 'HEAD'])
      assert.equal((await git(['ls-remote', REPOSITORY, `refs/heads/${branch}`])).split(/\s+/)[0], commit)
      assert.equal(await git(['config', '--get', 'remote.origin.url']), REPOSITORY)
      assert.equal(await git(['branch', '--show-current']), originalBranch)
      assert.equal(await git(['status', '--porcelain']), '')
      const observed = await (await fetch(`${services.origin}/observations`)).json()
      assert.equal(observed.errors.length, 0)
      assert.ok(observed.observations.some((value: Record<string, unknown>) => value.kind === 'pull-request-created' && value.issueId === issueId && value.commit === commit))
      assert.ok(observed.observations.some((value: Record<string, unknown>) => value.kind === 'synthetic-ci-checked' && value.commit === commit))
      await assert.rejects(git(['ls-remote', 'https://github.com/not-fixture/forbidden.git']), /transport 'https' not allowed/)
    } finally { child.kill(); lines.close(); await new Promise(resolve => child.once('close', resolve)) }
  } finally { await services.close(); await rm(directory, { recursive: true, force: true }) }
})

test('trace prerequisites verify local commands and the owned synthetic GitHub shim without service requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-trace-prerequisites-'))
  try {
    checkTracePrerequisites(directory)
    const script = await readFile(join(directory, 'fixture-bin', 'gh'), 'utf8')
    assert.ok(script.includes(fileURLToPath(new URL('../../scripts/dev-local/gh.mjs', import.meta.url))))
    assert.ok(!script.includes('gh auth') && !script.includes('github.com'))
    assert.throws(() => createTraceCodexBinary(directory, join(directory, 'fixture.jsonl'), join(dirname(directory), 'foreign', 'origin.git')), /SYNTHETIC_GIT_ORIGIN_REQUIRED/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('MVP subscription boundary retains real service authorization, private worker IPC and streamed tool calls',async()=>{
 const services=await startMvpServices(3191)
 const owner='mvp-owner',workspaceId=randomUUID(),consumerId=randomUUID(),connectionId=randomUUID(),bindingId=randomUUID()
 const binding={id:bindingId,ownerId:owner,workspaceId,consumerId,connectionId,connectionRevision:1,route:'codex_cpa' as const,modelId:MVP_SUBSCRIPTION_MODEL}
 const row={id:connectionId,ownerId:owner,workspaceId,provider:'codex' as const,state:'connected',epoch:'1',quota:{vendor:'codex',source:'official',status:'ok',plan:null,observedAt:new Date().toISOString(),windows:[{kind:'five_hour',used:0.1,resetsAt:null}]}}
 const config={scope:{ownerId:owner,workspaceId,connectionId,provider:'codex' as const},databaseUrl:'postgresql://ci:fixture@127.0.0.1:5432/mikka_e2e',infisicalOrigin:MVP_SERVICES,project:'mvp-synthetic',environment:'test',path:'/custody',workloadToken:'mvp-synthetic-custody',accessPath:'/access',accessToken:'mvp-synthetic-access'}
 const worker=new SubscriptionWorkerClient({binary:fileURLToPath(new URL('./subscription-worker.mjs',import.meta.url))},config)
 const repository={binding:async(user:string,id:string)=>{assert.equal(user,owner);assert.equal(id,bindingId);return binding},connection:async(user:string,id:string)=>{assert.equal(user,owner);assert.equal(id,connectionId);return row},scope:()=>config.scope,saveQuota:async()=>undefined} as unknown as SubscriptionRepository
 let scopeChecks=0
 const service=new SubscriptionService(repository,()=>worker,{ready:()=>true,nativeIsolation:'none'},undefined,async(user,id)=>{assert.equal(user,owner);assert.equal(id,workspaceId);scopeChecks++},async(scope,model,route)=>{assert.deepEqual(scope,{ownerId:owner,workspaceId});assert.equal(model,binding.modelId);assert.equal(route,binding.route)})
 try {
  const marker=`mvp-${randomUUID()}`,deviceId=randomUUID(),issueId=randomUUID(),agentId=randomUUID(),runId=randomUUID()
  await fetch(`${services.origin}/scenario`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({marker,title:'Subscription MVP'})})
  await fetch(`${services.origin}/scenario/device`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({deviceId})})
  const calls:string[]=[]
  const model=await service.model({ownerId:owner,workspaceId,consumerId,bindingId,execution:'model'})
  const result=streamText({model,prompt:`${marker}\nThe person selected device ${deviceId} in the task dialog.`,stopWhen:stepCountIs(5),maxRetries:0,tools:{
   create_issue:tool({inputSchema:z.object({title:z.string(),body:z.string()}),execute:()=>{calls.push('issue');return {id:issueId}}}),
   list_agents:tool({inputSchema:z.object({}),execute:()=>[{id:agentId,deviceId,harness:'mock',deviceOnline:true}]}),
   dispatch_run:tool({inputSchema:z.object({issueId:z.uuid(),agentId:z.uuid(),repo:z.string()}),execute:input=>{assert.equal(input.repo,REPOSITORY);assert.equal(input.issueId,issueId);calls.push('dispatch');return {runId,status:'queued'}}}),
  }})
  assert.match(await result.text,/启动线程/)
  assert.deepEqual(calls,['issue','dispatch']);assert.ok(scopeChecks>=4)
  const streamMarker=`mvp-stream-${randomUUID()}`
  const control=async(path:string)=>{
   const response=await fetch(`${services.origin}/streaming/${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({marker:streamMarker,first:'First visible',last:' then complete'})})
   assert.equal(response.ok,true)
   return response.json()
  }
  await control('scenario')
  const reader=streamText({model:await service.model({ownerId:owner,workspaceId,consumerId,bindingId,execution:'model'}),prompt:streamMarker,maxRetries:0}).textStream.getReader()
  assert.deepEqual(await reader.read(),{value:'First visible',done:false})
  assert.deepEqual(await control('state'),{started:1,released:false})
  const pending=reader.read()
  assert.equal(await Promise.race([pending.then(()=>true),delay(100).then(()=>false)]),false,'the worker must expose the first delta before the held model tail')
  await control('release')
  assert.deepEqual(await pending,{value:' then complete',done:false})
  assert.equal((await reader.read()).done,true)
  row.state='disconnected'
  await assert.rejects(service.model({ownerId:owner,workspaceId,consumerId,bindingId,execution:'model'}))
  const remote=new SubscriptionWorkerClient({binary:fileURLToPath(new URL('./subscription-worker.mjs',import.meta.url))},{...config,databaseUrl:'postgresql://ci:fixture@remote.invalid/production'})
  await assert.rejects(remote.call('prepare',{revision:1}))
 } finally {await services.close()}
})
