import { Platform } from 'react-native'
import { fetch as nativeFetch } from 'expo/fetch'
import { hostedApiUpgrade } from '@mikka/protocol/version'
import { currentAccount } from './config'
import { requireMobileUpdate } from './startup'

// eve's public client uses standards-based global fetch. React Native's default
// fetch buffers responses; Expo's implementation provides the streaming body.
// Limit that compatibility adapter to eve; existing API and upload transports keep theirs.
{
  const existing = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!/\/api\/agents\/eve\/v1\//.test(url)) return existing(input, init)
    const response = await (Platform.OS === 'web' ? existing(input, { ...init, credentials: 'include' }) : nativeFetch(input, { ...init, credentials: 'omit' }))
    const server = currentAccount().server.url
    if (response.status === 426 && url.startsWith(`${server}/api/`) && hostedApiUpgrade(await response.clone().json().catch(() => null))) requireMobileUpdate(server)
    return response
  }) as typeof globalThis.fetch
}
