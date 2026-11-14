import {evaluationBindingId} from '../../../../lib/eve/evaluation-context'
import { defineDynamic, defineMcpClientConnection } from 'eve/connections'
import { executionForSession } from '../../../../lib/eve/runtime'

export default defineDynamic(async ctx => {
  if(evaluationBindingId(ctx.session.auth.current))return null
  const { scope, execution, sourceEventId } = await executionForSession(ctx)
  const scheduledRead = sourceEventId ? await (await import('../../../../lib/eve/scheduled-read')).loadScheduledRead(scope,sourceEventId) : null
  if (scheduledRead) return null
  const { personalPlugins } = await import('../../../../lib/plugins/runtime')
  const snapshot = execution?.snapshot.personalPlugins ?? await personalPlugins.snapshot(scope.ownerId, undefined, scope.workspaceId)
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
