import { Platform } from 'react-native'
import { fetch as nativeFetch } from 'expo/fetch'

// eve's public client uses standards-based global fetch. React Native's default
// fetch buffers responses; Expo's implementation provides the streaming body.
// Limit that compatibility adapter to eve; existing API and upload transports keep theirs.
{
  const existing = globalThis.fetch
  globalThis.fetch = ((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!/\/api\/agents\/eve\/v1\//.test(url)) return existing(input, init)
    return Platform.OS === 'web' ? existing(input, { ...init, credentials: 'include' }) : nativeFetch(input, { ...init, credentials: 'omit' })
  }) as typeof globalThis.fetch
}
