import 'server-only'
import { eq } from 'drizzle-orm'
import { appCallSetting, callAppTool, listAppTools, type AppTool, type AppToolCall, type AppToolDeps, type AppToolExecution } from '@/lib/app-tools'
import { serverWriteJudge } from '@/lib/operations/write-judgment'
import { resolveComposioAccount } from '@/lib/composio-actions'
import { chosenComposioDefault } from '@/lib/composio-account-store'
import { getComposio } from '@/lib/composio'
import { db, pool } from '@/lib/db'
import { activeExecutionIdentity } from '@/lib/execution-identity'
import { readWriteSettingLayers } from '@/lib/operations/write-setting-layers'
import { pendingActions } from '@/lib/db/schema'
import { proposeAppToolCall } from '@/lib/pending-action-store'
import { isToolkitSlug, OWN_INTEGRATIONS } from '@/lib/composio-accounts'
import { composioToolkitLister, isNoAuthToolkit } from '@/lib/plugins/catalog'
import { MAX_RUN_APP_TOOLS, runAppTool, type RunAppScope } from '@/lib/run-app-mcp'

type Client = NonNullable<ReturnType<typeof getComposio>>

/** Runs a pinned call in one connected account, or with no account for an app that needs none. */
export async function executeAppToolCall(client: Client, userId: string, call: AppToolCall, accountId: string | null): Promise<AppToolExecution> {
  // A no-auth app's tools run with the person's id alone; every other call names its account.
  const result = await client.tools.execute(call.tool, { userId, ...(accountId ? { connectedAccountId: accountId } : {}), version: call.version, arguments: call.arguments })
  return { successful: result.successful, data: result.data, error: result.error, ...(result.logId ? { logId: result.logId } : {}) }
}

export function appToolDeps(userId: string, botId: string | null, client: Client): AppToolDeps {
  return {
    appAllowed: async toolkit => (await import('@/lib/app-policy/store')).botMayUseApp(botId, toolkit),
    noAuth: toolkit => isNoAuthToolkit(composioToolkitLister(client), toolkit).catch(() => false),
    resolveAccount: (toolkit, selected) => resolveComposioAccount(userId, toolkit, client, kit => chosenComposioDefault(userId, kit), selected),
    listTools: (toolkit, query) => client.tools.getRawComposioTools(query ? { toolkits: [toolkit], search: query, limit: 15 } : { toolkits: [toolkit], limit: 15 }) as Promise<AppTool[]>,
    getTool: slug => client.tools.getRawComposioToolBySlug(slug) as Promise<AppTool>,
    execute: (call, accountId) => executeAppToolCall(client, userId, call, accountId),
    setting: async (tool, toolkit) => {
      // Unreadable settings fail closed: a malformed workspace policy must not
      // fall through to the Decisions judge, which can allow when it is down.
      // The lookup covers the tool's slug, its app key and its legacy write action (send_slack_message).
      try { return appCallSetting(await readWriteSettingLayers(db, userId, botId), tool, toolkit) } catch (error) { throw new Error('integrationPolicyUnavailable', { cause: error }) }
    },
    judge: serverWriteJudge(userId, botId),
    recordStart: async (call, accountId) => {
      const id = crypto.randomUUID()
      await db.insert(pendingActions).values({ id, userId, botId, action: 'app_tool_call', input: call, connectedAccountId: accountId, status: 'running' })
      return id
    },
    recordEnd: async (id, outcome) => {
      await db.update(pendingActions).set({ status: outcome.status, error: outcome.error ?? null, result: outcome.result ?? null }).where(eq(pendingActions.id, id))
    },
    propose: (call, accountId) => proposeAppToolCall(userId, call, accountId, botId),
  }
}

export async function runAppTools(userId: string, botId: string | null, operation: 'list' | 'call', input: unknown) {
  const client = getComposio()
  if (!client) return { error: 'composioNotConfigured' }
  const deps = appToolDeps(userId, botId, client)
  return operation === 'list' ? listAppTools(deps, input) : callAppTool(deps, input)
}

/** The apps a device run may reach (one MCP entry each): connected by the owner, not one of Mikka's own integrations, and allowed for the Bot. */
export async function runAppToolkits(userId: string, botId: string | null): Promise<string[]> {
  const { connectedComposioApps } = await import('@/lib/suggestions/sources')
  const { botMayUseApp } = await import('@/lib/app-policy/store')
  const kits = (await connectedComposioApps(userId)).filter(kit => isToolkitSlug(kit) && !OWN_INTEGRATIONS.has(kit))
  const allowed = await Promise.all(kits.map(kit => botMayUseApp(botId, kit)))
  return kits.filter((_, index) => allowed[index]).sort()
}

/** A run's MCP entry for one app: its tools, and each call through the same rules as a cloud Bot's call_app_tool. */
export function runAppEntry(scope: RunAppScope) {
  const client = getComposio()
  if (!client) return null
  const deps = appToolDeps(scope.userId, scope.botId, client)
  const execute = deps.execute
  deps.execute = async (call, accountId) => {
    // Tool discovery / the write decision may wait on external services. Recheck at use, after those waits.
    await activeExecutionIdentity(pool, scope.runId, scope.userId)
    if (!await deps.appAllowed(call.toolkit)) throw new Error('integrationActionDenied')
    if (accountId) {
      const current = await deps.resolveAccount(call.toolkit, accountId)
      if (current.accountId !== accountId) throw new Error('integrationAccountUnavailable')
    }
    return execute(call, accountId)
  }
  return {
    list: async () => (await client.tools.getRawComposioTools({ toolkits: [scope.toolkit], limit: MAX_RUN_APP_TOOLS }) as AppTool[])
      .flatMap(tool => runAppTool(tool, scope.toolkit) ?? []),
    call: (tool: string, args: Record<string, unknown>) => callAppTool(deps, { toolkit: scope.toolkit, tool, arguments: args }),
  }
}
