import * as AppleAuthentication from 'expo-apple-authentication'
import * as Crypto from 'expo-crypto'
import * as SecureStore from 'expo-secure-store'
import { AppState, Platform } from 'react-native'
import { authClient } from './auth'
import { currentAccount } from './config'
import { accountStorageKey } from './server-store'
import { endLostSession } from './session'

const credentialKey = (id: string) => accountStorageKey(id, 'apple_user')

export async function forgetAppleCredential() {
  if (Platform.OS === 'ios') await SecureStore.deleteItemAsync(credentialKey(currentAccount().id))
}

/** Apple returns the name only at first consent. Better Auth verifies the token and nonce. */
export async function signInWithApple() {
  const account = currentAccount(), client = authClient
  const random = Array.from(await Crypto.getRandomBytesAsync(32), byte => byte.toString(16).padStart(2, '0')).join('')
  const receiver = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${account.server.url}/api/auth`)
  const nonce = `${random}.${receiver}`
  let credential: AppleAuthentication.AppleAuthenticationCredential
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME, AppleAuthentication.AppleAuthenticationScope.EMAIL],
      nonce: await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, nonce),
    })
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_REQUEST_CANCELED') return
    throw error
  }
  if (!credential.identityToken) return { error: { code: 'INVALID_TOKEN' } }
  if (currentAccount().id !== account.id) return
  // Persist before the server creates a session so its first credential check sees the Apple identity.
  await SecureStore.setItemAsync(credentialKey(account.id), credential.user)
  if (currentAccount().id !== account.id) return
  return client.signIn.social({ provider: 'apple', idToken: {
    token: credential.identityToken, nonce,
    ...(credential.fullName ? { user: { name: { firstName: credential.fullName.givenName ?? undefined, lastName: credential.fullName.familyName ?? undefined } } } : {}),
  } })
}

/** A lost session after the deletion handoff needs local cleanup and Apple revocation instructions. */
export async function finishAppleDeletionHandoff(accountId: string) {
  if (Platform.OS !== 'ios' || currentAccount().id !== accountId) return false
  const client = authClient
  if (!await SecureStore.getItemAsync(credentialKey(accountId))) return false
  const result = await client.getSession({ query: { disableCookieCache: true } })
  if (currentAccount().id !== accountId || result.error || result.data?.user) return false
  await endLostSession()
  await SecureStore.deleteItemAsync(credentialKey(accountId))
  return true
}

/** System revocation and foreground events cover a credential revoked while the app was closed. */
export function watchAppleCredential(accountId: string) {
  if (Platform.OS !== 'ios') return () => undefined
  let live = true
  const current = () => live && currentAccount().id === accountId
  const check = async () => {
    const user = await SecureStore.getItemAsync(credentialKey(accountId))
    if (!user || !current()) return
    const state = await AppleAuthentication.getCredentialStateAsync(user)
    if (current() && (state === AppleAuthentication.AppleAuthenticationCredentialState.REVOKED || state === AppleAuthentication.AppleAuthenticationCredentialState.NOT_FOUND)) {
      await endLostSession()
      await SecureStore.deleteItemAsync(credentialKey(accountId))
    }
  }
  const verify = () => { void check().catch(error => console.warn('Apple credential check unavailable', error instanceof Error ? error.name : 'UnknownError')) }
  verify()
  const revocation = AppleAuthentication.addRevokeListener(verify)
  const foreground = AppState.addEventListener('change', state => { if (state === 'active') verify() })
  return () => { live = false; revocation.remove(); foreground.remove() }
}
