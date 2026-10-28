import { Platform } from 'react-native'

/**
 * Where Mikka runs, with its base path (lib/base-path.ts on the server), e.g.
 * https://app.aspectlylabs.com/mikka. Set EXPO_PUBLIC_API_URL for a preview
 * deployment. On web the app is served next to the API, so it uses its own origin.
 */
const PRODUCTION = 'https://app.aspectlylabs.com/mikka'

export const API_URL = (process.env.EXPO_PUBLIC_API_URL
  ?? (Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.origin : PRODUCTION)).replace(/\/$/, '')
