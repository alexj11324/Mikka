import 'server-only'
import { eq } from 'drizzle-orm'
import { callAppTool, destructiveEvidence, destructiveQuestion, explicitSetting, listAppTools, type AppTool, type AppToolCall, type AppToolDeps, type AppToolExecution } from '@/lib/app-tools'
import { resolveComposioAccount } from '@/lib/composio-actions'
import { chosenComposioDefault } from '@/lib/composio-account-store'
import { getComposio } from '@/lib/composio'
import { db, pool } from '@/lib/db'
import { pendingActions } from '@/lib/db/schema'
import { proposeAppToolCall } from '@/lib/pending-action-store'

type Client = NonNullable<ReturnType<typeof getComposio>>

/** Runs a pinned call in one connected account. */
export async function executeAppToolCall(client: Client, userId: string, call: AppToolCall, accountId: string): Promise<AppToolExecution> {
  const result = await client.tools.execute(call.tool, { userId, connectedAccountId: accountId, version: call.version, arguments: call.arguments })
  return { successful: result.successful, data: result.data, error: result.error, ...(result.logId ? { logId: result.logId } : {}) }
}

/** The person's (agent) and workspace write settings for this Coordinator or Bot. */
async function readSettingLayers(userId: string, botId: string | null) {
  const { rows } = await pool.query<{ agent: unknown; workspace: unknown }>(
    'select h.external_write_permissions as agent, w.external_write_permissions as workspace from agent_kit_heads h left join workspace_computer_policies w on w."workspaceId" = h.workspace_id where h.owner_id=$1 and h.bot_key=$2',
    [userId, botId ?? 'coordinator'])
  return rows[0] ?? null
}

async function judge(userId: string, botId: string | null, call: AppToolCall, tool: AppTool) {
  const [{ hostedBillingScope }, { executionWorkspace }, { invokeDecision }] = await Promise.all([import('@/lib/abuse/context'), import('@/lib/execution-settings'), import('@/lib/coordinator/decide')])
  const result = await hostedBillingScope.run({ workspaceId: await executionWorkspace(userId, botId), ownerId: userId }, () => invokeDecision('app-tool-destructive', destructiveEvidence(call, tool), destructiveQuestion()))
  const answer = result?.answers.get('destructive')
  return answer?.type === 'predicate' ? answer.probability >= 0.5 : null
}

export function appToolDeps(userId: string, botId: string | null, client: Client): AppToolDeps {
  return {
    appAllowed: async toolkit => (await import('@/lib/app-policy/store')).botMayUseApp(botId, toolkit),
    resolveAccount: (toolkit, selected) => resolveComposioAccount(userId, toolkit, client, kit => chosenComposioDefault(userId, kit), selected),
    listTools: (toolkit, query) => client.tools.getRawComposioTools(query ? { toolkits: [toolkit], search: query, limit: 15 } : { toolkits: [toolkit], limit: 15 }) as Promise<AppTool[]>,
    getTool: slug => client.tools.getRawComposioToolBySlug(slug) as Promise<AppTool>,
    execute: (call, accountId) => executeAppToolCall(client, userId, call, accountId),
    setting: async (tool, toolkit) => {
      try { return explicitSetting(await readSettingLayers(userId, botId), [tool, toolkit]) } catch { return 'ask' }
    },
    judgeDestructive: (call, tool) => judge(userId, botId, call, tool).catch(() => null),
    recordStart: async (call, accountId) => {
      const id = crypto.randomUUID()
      await db.insert(pendingActions).values({ id, userId, action: 'app_tool_call', input: call, connectedAccountId: accountId, status: 'running' })
      return id
    },
    recordEnd: async (id, outcome) => {
      await db.update(pendingActions).set({ status: outcome.status, error: outcome.error ?? null, result: outcome.result ?? null }).where(eq(pendingActions.id, id))
    },
    propose: (call, accountId) => proposeAppToolCall(userId, call, accountId),
  }
}

export async function runAppTools(userId: string, botId: string | null, operation: 'list' | 'call', input: unknown) {
  const client = getComposio()
  if (!client) return { error: 'composioNotConfigured' }
  const deps = appToolDeps(userId, botId, client)
  return operation === 'list' ? listAppTools(deps, input) : callAppTool(deps, input)
}
