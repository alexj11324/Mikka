import {evaluationBindingId} from '../../../../lib/eve/evaluation-context'
import { defineDynamic, defineMcpClientConnection } from 'eve/connections'
import { turnPolicy, turnRequest } from '../../../../lib/eve/runtime'
import { scopeFromAuth } from '../../../../lib/eve/scope'
import { agentKitEnabled } from '../../../../lib/agent-kit/config'

export default defineDynamic(async ctx => {
  if(evaluationBindingId(ctx.session.auth.current))return null
  if (turnRequest.get().scheduledRead) return null
  const scope = scopeFromAuth(ctx.session.auth.current)
  const policy = turnPolicy.get()
  const { personalPlugins } = await import('../../../../lib/plugins/runtime')
  let snapshot = policy?.personalPlugins
  if (!policy && !agentKitEnabled()) snapshot = await personalPlugins.snapshot(scope.ownerId, undefined, scope.workspaceId)
  if (!snapshot) return null
  return Object.fromEntries(await Promise.all(snapshot.servers.map(async server => {
    const connection = await personalPlugins.mcpConnection(scope.ownerId, server.id, server.revision, snapshot.mcpAuthority)
    if (connection.transport === 'stdio') return null
    return ['mcp-' + server.id, defineMcpClientConnection({
      url: connection.url, description: connection.name,
      instanceKey: JSON.stringify([server.id,server.revision,scope.workspaceId]),
      headers: async () => (await personalPlugins.mcpConnection(scope.ownerId, server.id, server.revision, snapshot.mcpAuthority)).headers,
    })]
  })).then(entries => entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null)))
})
