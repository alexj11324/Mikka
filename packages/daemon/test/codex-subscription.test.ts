import { ToolApprovalGate } from "../src/agents/tool-approval"
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"

import { CodexAdapter, type CodexAdapterOptions } from "../src/adapters/codex"
import { NoSandbox } from "../src/agents/sandbox"
import { buildChildEnv } from "../src/env"
import { createLogger } from "../src/log"
import { cleanupTempDirs, makeRepo, tempDir } from "./helpers"

afterEach(cleanupTempDirs)

it('does not accept the public broker marker as a direct OAuth credential', async () => {
  const { adapter, options } = await fixture({ accountId: 'fixture-account', token: async () => ({ accessToken: 'mikka-native-broker-placeholder', chatgptAccountId: 'fixture-account' }) })
  await expect(adapter.start(options)).rejects.toThrow('Codex subscription authentication unavailable')
})

it('requires a trusted hosted spawn for the owned subscription broker', async () => {
  const { options, stateDir } = await fixture()
  const verify = vi.fn(async () => {})
  const adapter = new CodexAdapter({ stateDir, sandbox: new NoSandbox(), hostedSubscriptionBroker: { verify } })
  await expect(adapter.start(options)).rejects.toThrow('Codex subscription authentication unavailable')
  expect(verify).not.toHaveBeenCalled()
})

it.each(['api_key', 'provider', 'oauth'] as const)('does not mix owned broker transport with an ordinary %s credential', async kind => {
  const { options, stateDir, source } = await fixture()
  const spawn = vi.fn(async () => { throw new Error('must not spawn') })
  const verify = vi.fn(async () => {})
  const adapter = new CodexAdapter({ stateDir, sandbox: new NoSandbox(), spawnCli: spawn, hostedSubscriptionBroker: { verify }, ...(kind === 'oauth' ? { subscriptionAuth: source } : {}) })
  const credential = kind === 'api_key' ? { kind: 'api_key' as const, key: 'synthetic-private-key' }
    : kind === 'provider' ? { kind: 'provider' as const, protocol: 'openai' as const, baseUrl: 'https://gateway.example.test', key: 'synthetic-private-key' } : undefined
  await expect(adapter.start({ ...options, credential })).rejects.toThrow('Codex subscription authentication unavailable')
  expect(spawn).not.toHaveBeenCalled()
  expect(verify).not.toHaveBeenCalled()
})

it('rechecks revocation after initialization before starting the first native turn', async () => {
  const verify = vi.fn(async () => { throw new Error('fixture-access revoked') })
  const { adapter, options } = await fixture({ accountId: 'fixture-account', verify, token: async () => ({ accessToken: 'fixture-access', chatgptAccountId: 'fixture-account' }) })
  await expect(adapter.start(options)).rejects.toThrow('Codex subscription authentication unavailable')
  expect(verify).toHaveBeenCalledOnce()
})

async function fixture(token?: CodexAdapterOptions["subscriptionAuth"]) {
  const home = tempDir("mikka-native-owner-")
  const userHome = join(home, "native")
  mkdirSync(userHome)
  // A native auth file must not be linked/read when host-managed auth is used.
  writeFileSync(
    join(userHome, "auth.json"),
    "DO NOT READ: synthetic native state"
  )
  const binary = resolve(
    import.meta.dirname,
    "fakes/fake-codex-subscription.mjs"
  )
  chmodSync(binary, 0o755)
  const stateDir = tempDir("mikka-external-state-")
  const source = token ?? {
    accountId: "fixture-account",
    token: vi.fn(async (refresh: boolean) => ({
      accessToken: refresh ? "fixture-access-rotated" : "fixture-access",
      chatgptAccountId: "fixture-account",
      chatgptPlanType: "plus"
    }))
  }
  const adapter = new CodexAdapter({
    sandbox: new NoSandbox(),
    stateDir,
    binary,
    userHome,
    subscriptionAuth: source
  })
  const options = {
    runId: "external-run",
    toolApproval: new ToolApprovalGate("external-run", { isLive: () => true }),
    cwd: await makeRepo(),
    prompt: "REFRESH",
    env: buildChildEnv({ host: { PATH: process.env.PATH, HOME: home } }),
    log: createLogger({ level: "silent" })
  }
  return { adapter, options, source, stateDir }
}

it("logs in through official host-managed RPC and services its refresh callback with access-only material", async () => {
  const { adapter, options, source } = await fixture()
  const session = await adapter.start(options)
  const events = []
  for await (const event of session.events()) events.push(event)
  expect(source.token).toHaveBeenNthCalledWith(1, false)
  expect(source.token).toHaveBeenNthCalledWith(2, true)
  expect(events.at(-1)).toMatchObject({ type: "exit", outcome: "succeeded" })
  expect(JSON.stringify(events)).not.toContain("fixture-access")
})

it("fails closed for an unsupported native auth RPC without exposing upstream errors or falling back", async () => {
  const { adapter, options } = await fixture({
    accountId: "fixture-account",
    token: async () => ({
      accessToken: "fixture-unsupported",
      chatgptAccountId: "fixture-account"
    })
  })
  await expect(adapter.start(options)).rejects.toThrow(
    "Codex subscription authentication unavailable"
  )
})

it("rejects account replacement from the token broker", async () => {
  const { adapter, options } = await fixture({
    accountId: "fixture-account",
    token: async () => ({
      accessToken: "fixture-access",
      chatgptAccountId: "someone-else"
    })
  })
  await expect(adapter.start(options)).rejects.toThrow(
    "Codex subscription authentication unavailable"
  )
})

it("refuses a refresh request for another account before invoking the broker", async () => {
  const { adapter, options, source } = await fixture()
  const session = await adapter.start({ ...options, prompt: "WRONG REFRESH" })
  const events = []
  for await (const event of session.events()) events.push(event)
  expect(source.token).toHaveBeenCalledOnce()
  expect(events.at(-1)).toMatchObject({
    type: "exit",
    outcome: "failed",
    error: "Codex subscription authentication unavailable"
  })
})

it("does not accept an API-key environment for subscription execution", async () => {
  const { adapter, options, source } = await fixture()
  await expect(
    adapter.start({
      ...options,
      env: { ...options.env, OPENAI_API_KEY: "fixture-paid-key" }
    })
  ).rejects.toThrow("Codex subscription authentication unavailable")
  expect(source.token).not.toHaveBeenCalled()
  expect(existsSync(join(options.cwd, "auth.json"))).toBe(false)
})

it("refuses an app-server that accepts login as a paid API-key mode", async () => {
  const { adapter, options } = await fixture({
    accountId: "fixture-account",
    token: async () => ({
      accessToken: "fixture-paid-mode",
      chatgptAccountId: "fixture-account"
    })
  })
  await expect(adapter.start(options)).rejects.toThrow(
    "Codex subscription authentication unavailable"
  )
})

it.each(["FAIL", "CRASH"])(
  "does not expose auth/provider diagnostics on %s",
  async (prompt) => {
    const { adapter, options } = await fixture()
    const childLogger=options.log.child<string>({})
    const warn = vi.spyOn(childLogger, 'warn')
    vi.spyOn(options.log, 'child').mockReturnValue(childLogger)
    const session = await adapter.start({ ...options, prompt })
    const events = []
    for await (const event of session.events()) events.push(event)
    expect(events.at(-1)).toMatchObject({
      type: "exit",
      outcome: "failed",
      error: prompt === 'FAIL' ? 'Codex subscription execution failed (turn_completed: unknown)' : 'Codex subscription execution failed (child_exit: cli_exited_early)'
    })
    expect(JSON.stringify({events, logs: warn.mock.calls})).not.toContain("fixture-secret")
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({event:'codex_subscription_turn_failed',phase:prompt==='FAIL'?'turn_completed':'child_exit'}),'Codex subscription turn failed')
  }
)


it.each([
  { phase:'turn_completed', category:'responseStreamDisconnected', status:502, scenario:{error:{message:'fixture-secret-provider-body',additionalDetails:'fixture-access',codexErrorInfo:{responseStreamDisconnected:{httpStatusCode:502}}}} },
  { phase:'turn_completed', category:'unauthorized', scenario:{error:{message:'fixture-secret-provider-body',codexErrorInfo:'unauthorized'}} },
  { phase:'turn_completed', category:'httpConnectionFailed', status:503, scenario:{notification:{message:'fixture-secret-provider-body',codexErrorInfo:{httpConnectionFailed:{httpStatusCode:503}}}} },
  { phase:'turn_completed', category:'unknown', scenario:{error:{message:'fixture-secret-provider-body',additionalDetails:'fixture-access',codexErrorInfo:{'fixture-secret-field':{httpStatusCode:503}}}} },
  { phase:'turn_completed', category:'unknown', scenario:{error:{message:'fixture-secret-provider-body',codexErrorInfo:'fixture-secret-category'}} },
  { phase:'turn_completed', category:'unknown', scenario:{error:{message:'fixture-secret-provider-body',code:'fixture-secret-code'}} },
  { phase:'turn_completed', category:'responseStreamDisconnected', scenario:{error:{message:'fixture-secret-provider-body',codexErrorInfo:{responseStreamDisconnected:{httpStatusCode:'fixture-secret-status'}}}} },
  { phase:'turn_completed', category:'httpConnectionFailed', scenario:{error:{message:'fixture-secret-provider-body',codexErrorInfo:{httpConnectionFailed:{httpStatusCode:700}}}} },
  { phase:'turn_completed', category:'activeTurnNotSteerable', scenario:{error:{message:'fixture-secret-provider-body',codexErrorInfo:{activeTurnNotSteerable:{turnKind:'fixture-secret-turnkind'}}}} },
])('retains safe terminal classification $category without provider text', async ({phase,category,status,scenario})=>{
  const {adapter,options}=await fixture();
  const childLogger=options.log.child<string>({});const warn=vi.spyOn(childLogger,'warn');
  vi.spyOn(options.log,'child').mockReturnValue(childLogger);
  const session=await adapter.start({...options,prompt:'DIAGNOSTIC '+JSON.stringify(scenario)});
  const events=[];for await(const event of session.events())events.push(event);
  expect(events.at(-1)).toMatchObject({type:'exit',outcome:'failed',error:`Codex subscription execution failed (${phase}: ${category}${status?`; HTTP ${status}`:''})`});
  expect(warn).toHaveBeenCalledWith(expect.objectContaining({event:'codex_subscription_turn_failed',phase,category,...(status?{httpStatus:status}:{})}),'Codex subscription turn failed');
  const retained=JSON.stringify({events,logs:warn.mock.calls});
  expect(retained).not.toContain('fixture-secret');expect(retained).not.toContain('fixture-access');
});

it('keeps quota reset metadata and ignores a retrying error as a terminal failure', async()=>{
  for(const scenario of [
    {error:{message:'fixture-secret-provider-body',codexErrorInfo:'usageLimitExceeded'},rateLimits:{primary:{usedPercent:100,resetsAt:2000000000}}},
    {error:{message:'fixture-secret-provider-body',codexErrorInfo:{responseTooManyFailedAttempts:{httpStatusCode:429}}},rateLimits:{primary:{usedPercent:100,resetsAt:2000000000}}},
    {notification:{message:'fixture-secret-provider-body',codexErrorInfo:'serverOverloaded'},willRetry:true,succeed:true},
  ]){
    const {adapter,options}=await fixture();const session=await adapter.start({...options,prompt:'DIAGNOSTIC '+JSON.stringify(scenario)});
    const events=[];for await(const event of session.events())events.push(event);
    expect(events.at(-1)).toMatchObject(scenario.succeed?{type:'exit',outcome:'succeeded'}:{type:'exit',outcome:'failed',quota:{resetsAt:new Date(2000000000*1000).toISOString()}});
    expect(JSON.stringify(events)).not.toContain('fixture-secret');
  }
});

it('keeps only a numeric RPC code when turn/start fails', async()=>{
  const {adapter,options}=await fixture();const childLogger=options.log.child<string>({});const warn=vi.spyOn(childLogger,'warn');vi.spyOn(options.log,'child').mockReturnValue(childLogger);
  await expect(adapter.start({...options,prompt:'DIAGNOSTIC '+JSON.stringify({rpc:{code:-32603,message:'fixture-secret-provider-body',data:{secret:'fixture-access'}}})})).rejects.toThrow('Codex subscription execution failed (turn_start: rpc_refused; RPC -32603)');
  expect(warn).toHaveBeenCalledWith(expect.objectContaining({event:'codex_subscription_turn_failed',phase:'turn_start',category:'rpc_refused',rpcCode:-32603}),'Codex subscription turn failed');
  expect(JSON.stringify(warn.mock.calls)).not.toContain('fixture-secret');expect(JSON.stringify(warn.mock.calls)).not.toContain('fixture-access');
});


it('retains only the JSON-RPC library numeric rejection code when the wire code is invalid',async()=>{
  const {adapter,options}=await fixture();const childLogger=options.log.child<string>({});const warn=vi.spyOn(childLogger,'warn');vi.spyOn(options.log,'child').mockReturnValue(childLogger);
  await expect(adapter.start({...options,prompt:'DIAGNOSTIC '+JSON.stringify({rpc:{code:'fixture-secret-code',message:'fixture-secret-body',data:{secret:'fixture-access'}}})})).rejects.toThrow('Codex subscription execution failed (turn_start: rpc_refused; RPC -32001)');
  const calls=warn.mock.calls.filter(([fields])=>fields && typeof fields==='object' && 'event' in fields && fields.event==='codex_subscription_turn_failed');
  expect(calls).toHaveLength(1);expect(calls[0][0]).toHaveProperty('rpcCode',-32001);
  expect(JSON.stringify(warn.mock.calls)).not.toContain('fixture-secret');expect(JSON.stringify(warn.mock.calls)).not.toContain('fixture-access');
});
