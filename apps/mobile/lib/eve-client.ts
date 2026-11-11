import { Client, type ClientOptions } from 'eve/client'
import { apiConnection, authHeaders, type ApiConnection } from './api'
import './eve-fetch'

/** Native and web mobile clients use the server-owned Bot mapping and fresh credentials. */
export function eveClientOptions(botId: string | null, connection: ApiConnection = apiConnection()): ClientOptions {
  return {
    baseUrl: `${connection.account.server.url}/api/agents${botId ? `?botId=${encodeURIComponent(botId)}` : ''}`,
    headers: () => authHeaders(connection),
  }
}

export function eveChatClient(botId: string | null = null) {
  return new Client(eveClientOptions(botId))
}
