import { Client, type ClientOptions } from 'eve/client'
import { Platform } from 'react-native'
import { apiConnection, authHeaders, type ApiConnection } from './api'
import './eve-fetch'

/** Native and web mobile clients use the server-owned Bot mapping and fresh credentials. */
export function eveClientOptions(botId: string | null, connection: ApiConnection = apiConnection()): ClientOptions {
  // Native fetch has no browser Origin; bind it to the same captured server as its cookie jar.
  const origin = Platform.OS === 'web' ? null : new URL(connection.account.server.url).origin
  return {
    baseUrl: `${connection.account.server.url}/api/agents${botId ? `?botId=${encodeURIComponent(botId)}` : ''}`,
    headers: async () => ({ ...await authHeaders(connection), ...(origin ? { origin } : {}) }),
  }
}

export function eveChatClient(botId: string | null = null) {
  return new Client(eveClientOptions(botId))
}
