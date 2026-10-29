import type { SubscriptionUse, SubscriptionAccess } from '@mikka/protocol/subscription'
import { authorizeSubscriptionUse } from '@mikka/protocol/subscription'
import { CodexAdapter } from './adapters/codex'
import { ClaudeAdapter } from './adapters/claude'
import type { StartOptions, AgentSession } from './adapters/types'
import type { AgentSandbox } from './agents/sandbox'
import { startSubscriptionSession } from './subscription'
import type { NativeLease, SubscriptionWorkerClient } from './subscription-worker-client'
import { requireRunToolApproval } from './agents/tool-approval'

/** Called inside the trusted owner runtime, never from a task-supplied cwd/env. */
export async function launchHostedSubscription(use: SubscriptionUse, options: StartOptions, host: {
  access(): Promise<SubscriptionAccess>
  worker: Pick<SubscriptionWorkerClient, 'call'>
  stateDir: string
  sandbox: AgentSandbox
  codexBinary?: string
  claudeBinary?: string
  revocationPollMs?: number
}): Promise<AgentSession> {
  const gate = requireRunToolApproval(options.runId, options.toolApproval)
  const check = async () => {
    if (!await gate.checkLive()) { gate.revoke(); throw new Error('Run tool approval unavailable') }
    const access = await host.access()
    if (gate.revoked) throw new Error('Run tool approval unavailable')
    return authorizeSubscriptionUse({ ...use, execution: 'native' }, access)
  }
  const authorized = await check()
  const revision = authorized.binding.connectionRevision
  let lastToken: string | undefined
  let credentialCalls = 0
  const token = async (forceRefresh = false) => {
    credentialCalls++
    try {
    await check()
    let lease = await host.worker.call<NativeLease>('nativeAuth', { revision })
    // The quota probe or another consumer may already have rotated the grant.
    if (forceRefresh && lease.accessToken === lastToken) {
      await host.worker.call('refresh', { revision })
      lease = await host.worker.call<NativeLease>('nativeAuth', { revision })
    }
    lastToken = lease.accessToken
    await check()
    return lease
    } finally { credentialCalls-- }
  }
  const first = await token()
  const accountId = authorized.binding.route === 'codex_cli' ? first.chatgptAccountId : first.accountId
  if (!accountId) throw new Error('subscription_native_auth_unavailable')
  let initial: NativeLease | undefined = first
  const next = async (force = false) => {
    await check()
    if (initial && !force) { const value = initial; initial = undefined; return value }
    return token(force)
  }
  const session = await startSubscriptionSession(use, options, { access: host.access,
    adapter: async () => authorized.binding.route === 'codex_cli'
      ? new CodexAdapter({ stateDir: host.stateDir, sandbox: host.sandbox, binary: host.codexBinary,
        subscriptionAuth: { accountId, verify: async () => { await check() }, token: async force => { const value = await next(force); return { accessToken: value.accessToken, chatgptAccountId: value.chatgptAccountId ?? '', chatgptPlanType: value.chatgptPlanType } } } })
      : new ClaudeAdapter({ stateDir: host.stateDir, sandbox: host.sandbox, binary: host.claudeBinary,
        subscriptionAuth: { accountId, verify: async () => { await check() }, token: async () => { const value = await next(); return { accountId: value.accountId ?? '', accessToken: value.accessToken, expiresAt: value.expiresAt ?? '' } } } })
  })
  let ended = false
  let checking = false
  const timer = setInterval(() => {
    if (ended || checking) return
    checking = true
    void (async () => {
      if (!await gate.checkLive()) { gate.revoke(); throw new Error('Run tool approval unavailable') }
      const access = await host.access()
      if (gate.revoked) throw new Error('Run tool approval unavailable')
      // A host refresh callback waits for durable publication. Do not cancel
      // that same native session for its own transient refresh state. Epoch,
      // ownership, binding, readiness, quota and billing checks still apply;
      // a reconnect/disconnect immediately fails those checks.
      if (credentialCalls > 0 && access.credentialTransition && access.connection?.revision === revision) {
        authorizeSubscriptionUse({ ...use, execution: 'native' }, { ...access, connection: { ...access.connection, state: 'connected' } })
      } else authorizeSubscriptionUse({ ...use, execution: 'native' }, access)
    })().catch(async () => { await session.cancel(); cleanup() }).finally(() => { checking = false })
  }, host.revocationPollMs ?? 1000)
  timer.unref()
  const off = gate.onRevoke(() => { void session.cancel().catch(() => undefined).finally(cleanup) })
  function cleanup() { ended = true; clearInterval(timer); off(); gate.revoke() }
  return {
    sessionId: session.sessionId,
    async *events() { try { yield* session.events() } finally { cleanup() } },
    send: text => { if (gate.revoked) throw new Error('Run tool approval unavailable'); return session.send(text) },
    async cancel() { cleanup(); await session.cancel() },
    async detach() { cleanup(); if (session.detach) await session.detach() }
  }
}

// Runner-side factory. The broker can be a private control-plane channel;
// Infisical workload credentials need not enter the owner execution runtime.
export function hostedSubscriptionLauncher(options: StartOptions, host: Omit<Parameters<typeof launchHostedSubscription>[2], 'worker' | 'access'>) {
  return (context: { use: SubscriptionUse; modelId: string; worker: Pick<SubscriptionWorkerClient, 'call'>; access(): Promise<SubscriptionAccess> }) => launchHostedSubscription(context.use, { ...options, model: context.modelId }, { ...host, worker: context.worker, access: context.access })
}
