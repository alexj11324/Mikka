import { useEffect, useState, useSyncExternalStore } from 'react'
import * as AppleAuthentication from 'expo-apple-authentication'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, TextInput, useColorScheme, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { BotAvatar, SourceIcon, Spinner } from '@/components/icons'
import { Text } from '@/components/Text'
import { authClient } from '@/lib/auth'
import { forgetAppleCredential, signInWithApple } from '@/lib/apple-auth'
import { clearSessionExpired, sessionExpired } from '@/lib/session'
import { signInErrorLine } from '@/lib/sign-in-error'
import { colors, font } from '@/lib/theme'
import { ServerSelection } from '@/features/accounts/components/server-selection'
import { CardButton } from '@/components/cards'
import { currentAccount, servers } from '@/lib/config'
import { selectMobileAccount } from '@/lib/server-actions'
import { serverCopy as copy } from '@/lib/server-copy'
import { openPrivacyPolicy } from '@/lib/web'
import { mobileMessages as messages } from '@/lib/messages'

/**
 * Sign in, with the web's words (messages/zh-CN.json Auth): Google and GitHub
 * open the system browser and return to mikka://; email and password work
 * too. No explanatory copy (R-40).
 */
export function SignIn() {
  const insets = useSafeAreaInsets()
  const dark = useColorScheme() === 'dark'
  const [appleAvailable, setAppleAvailable] = useState(false)
  useEffect(() => {
    let live = true
    if (Platform.OS === 'ios') void AppleAuthentication.isAvailableAsync().then(available => { if (live) setAppleAvailable(available) }).catch(() => undefined)
    return () => { live = false }
  }, [])
  const state = useSyncExternalStore(servers.subscribe, servers.snapshot, servers.snapshot)
  const account = currentAccount()
  const [choosing, setChoosing] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [active, setActive] = useState<'apple' | 'google' | 'github' | 'email' | null>(null)
  const busy = active !== null || switching
  // After the session was lost (lib/session.ts) the first thing shown says why the app signed out.
  const [error, setError] = useState(() => sessionExpired() ? messages.Auth.sessionExpired : '')

  const run = async (provider: 'apple' | 'google' | 'github' | 'email', work: () => Promise<{ error?: unknown } | undefined | void>) => {
    if (busy) return
    setActive(provider)
    setError('')
    clearSessionExpired()
    try {
      if (provider !== 'apple') await forgetAppleCredential()
      const result = await work()
      if (result && 'error' in result && result.error) setError(signInErrorLine(result.error as { code?: string; status?: number }, messages.Auth))
    } catch {
      setError(messages.Auth.connectionFailed)
    } finally {
      setActive(null)
    }
  }

  const select = async (id: string) => {
    if (busy) return
    setSwitching(true); setError('')
    try { await selectMobileAccount(id); clearSessionExpired() }
    catch { setError(copy.switchFailed) }
    finally { setSwitching(false) }
  }
  const social = (provider: 'google' | 'github') => run(provider, () => authClient.signIn.social({ provider, callbackURL: '/' }))
  const submit = () => {
    if (!email.trim() || !password) return
    return run('email', () => authClient.signIn.email({ email: email.trim(), password }))
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.screen}>
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={[styles.body, { paddingTop: insets.top + 80, paddingBottom: insets.bottom + 24 }]}>
      <View style={styles.brand}>
        <BotAvatar size={56} />
        <Text style={styles.title}>Mikka</Text>
      </View>
      <ServerSelection choosing={choosing} setChoosing={setChoosing} disabled={busy} />
      {!choosing ? <>
      <View style={{ gap: 10 }}>
        {appleAvailable && account.server.signIn.apple ? <View pointerEvents={busy ? 'none' : 'auto'} accessibilityState={{ disabled: busy, busy: active === 'apple' }} style={busy ? { opacity: 0.4 } : undefined}>
          <AppleAuthentication.AppleAuthenticationButton testID="signin-apple" accessibilityState={{ disabled: busy, busy: active === 'apple' }} buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE} buttonStyle={dark ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK} cornerRadius={26} style={{ height: 52, width: '100%' }} onPress={() => void run('apple', signInWithApple)} />
        </View> : null}
        {account.server.signIn.google ? <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy, busy: active === 'google' }} aria-disabled={Platform.OS === 'web' ? busy : undefined} aria-busy={Platform.OS === 'web' ? active === 'google' : undefined} disabled={busy} onPress={() => social('google')} style={({ pressed }) => [styles.provider, pressed && styles.pressed]}>
          {active === 'google' ? <Spinner size={20} /> : <SourceIcon source="google" size={20} />}
          <Text style={styles.providerText}>{messages.Auth.continueGoogle}</Text>
        </Pressable> : null}
        {account.server.signIn.github ? <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy, busy: active === 'github' }} aria-disabled={Platform.OS === 'web' ? busy : undefined} aria-busy={Platform.OS === 'web' ? active === 'github' : undefined} disabled={busy} onPress={() => social('github')} style={({ pressed }) => [styles.provider, pressed && styles.pressed]}>
          {active === 'github' ? <Spinner size={20} /> : <SourceIcon source="github" size={20} />}
          <Text style={styles.providerText}>{messages.Auth.continueGithub}</Text>
        </Pressable> : null}
      </View>
      {account.server.signIn.email ? <>
      {(appleAvailable && account.server.signIn.apple) || account.server.signIn.google || account.server.signIn.github ? <Text style={styles.or}>{messages.Auth.orEmail}</Text> : null}
      <View style={{ gap: 10 }}>
        <TextInput testID="signin-email" accessibilityLabel={messages.Auth.email} editable={!busy} value={email} onChangeText={setEmail} placeholder={messages.Auth.email} placeholderTextColor={colors.secondary} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="emailAddress" style={styles.input} />
        <TextInput testID="signin-password" accessibilityLabel={messages.Auth.password} editable={!busy} value={password} onChangeText={setPassword} placeholder={messages.Auth.password} placeholderTextColor={colors.secondary} secureTextEntry autoComplete="current-password" textContentType="password" style={styles.input} onSubmitEditing={submit} />
        <Pressable testID="signin-submit" accessibilityRole="button" accessibilityState={{ disabled: busy || !email.trim() || !password, busy: active === 'email' }} aria-disabled={Platform.OS === 'web' ? busy || !email.trim() || !password : undefined} aria-busy={Platform.OS === 'web' ? active === 'email' : undefined} disabled={busy || !email.trim() || !password} onPress={submit} style={({ pressed }) => [styles.submit, (busy || !email.trim() || !password) && { opacity: 0.4 }, pressed && { opacity: 0.85 }]}>
          <Text style={styles.submitText}>{active === 'email' ? messages.Auth.signingIn : messages.Auth.signIn}</Text>
        </Pressable>
      </View>
      </> : null}
      </> : null}
      {!choosing && state.accounts.some(saved => saved.user && saved.id !== account.id) ? <View style={{ gap: 10 }}>
        <Text style={styles.or}>{copy.savedAccounts}</Text>
        {state.accounts.filter(saved => saved.user && saved.id !== account.id).map(saved => <CardButton key={saved.id} label={`${saved.user!.email} · ${saved.server.name}`} disabled={busy} onPress={() => void select(saved.id)} />)}
      </View> : null}
      <Pressable accessibilityRole="link" onPress={() => void openPrivacyPolicy()} style={({ pressed }) => [{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }, pressed && { opacity: 0.6 }]}>
        <Text style={styles.or}>{messages.Common.privacyPolicy}</Text>
      </Pressable>
      {error ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{error}</Text> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  body: { flexGrow: 1, paddingHorizontal: 24, gap: 18 },
  brand: { alignItems: 'center', gap: 12, marginBottom: 28 },
  title: { fontSize: 30, fontWeight: '700' },
  provider: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 52, paddingVertical: 14, borderRadius: 26, backgroundColor: colors.bubble },
  pressed: { backgroundColor: colors.pressed },
  providerText: { fontSize: 16, fontWeight: '600' },
  or: { alignSelf: 'center', color: colors.secondary, fontSize: 13 },
  input: { minHeight: 52, paddingVertical: 14, borderRadius: 14, backgroundColor: colors.bubble, paddingHorizontal: 16, fontSize: 16, fontFamily: font, color: colors.text, outlineStyle: 'none' } as never,
  submit: { minHeight: 52, paddingVertical: 14, borderRadius: 26, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  submitText: { color: colors.onInk, fontSize: 16, fontWeight: '600' },
  error: { color: colors.danger, fontSize: 13, textAlign: 'center' },
})
