import { useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { BotAvatar, SourceIcon, Spinner } from '@/components/icons'
import { Text } from '@/components/Text'
import { authClient } from '@/lib/auth'
import { clearSessionExpired, sessionExpired } from '@/lib/session'
import { signInErrorLine } from '@/lib/sign-in-error'
import { colors, font } from '@/lib/theme'

/**
 * Sign in, with the web's words (messages/zh-CN.json Auth): Google and GitHub
 * open the system browser and return to mikka://; email and password work
 * too. No explanatory copy (R-40).
 */
export function SignIn() {
  const insets = useSafeAreaInsets()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [active, setActive] = useState<'google' | 'github' | 'email' | null>(null)
  const busy = active !== null
  // After the session was lost (lib/session.ts) the first thing shown says why the app signed out.
  const [error, setError] = useState(() => sessionExpired() ? '登录已失效，请重新登录。' : '')

  const run = async (provider: 'google' | 'github' | 'email', work: () => Promise<{ error?: unknown } | undefined | void>) => {
    if (busy) return
    setActive(provider)
    setError('')
    clearSessionExpired()
    try {
      const result = await work()
      if (result && 'error' in result && result.error) setError(signInErrorLine(result.error as { code?: string; status?: number }))
    } catch {
      setError('暂时无法连接，请稍后重试。')
    } finally {
      setActive(null)
    }
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
      <View style={{ gap: 10 }}>
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy, busy: active === 'google' }} aria-disabled={Platform.OS === 'web' ? busy : undefined} aria-busy={Platform.OS === 'web' ? active === 'google' : undefined} disabled={busy} onPress={() => social('google')} style={({ pressed }) => [styles.provider, pressed && styles.pressed]}>
          {active === 'google' ? <Spinner size={20} /> : <SourceIcon source="google" size={20} />}
          <Text style={styles.providerText}>使用 Google 继续</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy, busy: active === 'github' }} aria-disabled={Platform.OS === 'web' ? busy : undefined} aria-busy={Platform.OS === 'web' ? active === 'github' : undefined} disabled={busy} onPress={() => social('github')} style={({ pressed }) => [styles.provider, pressed && styles.pressed]}>
          {active === 'github' ? <Spinner size={20} /> : <SourceIcon source="github" size={20} />}
          <Text style={styles.providerText}>使用 GitHub 继续</Text>
        </Pressable>
      </View>
      <Text style={styles.or}>或</Text>
      <View style={{ gap: 10 }}>
        <TextInput accessibilityLabel="邮箱" editable={!busy} value={email} onChangeText={setEmail} placeholder="邮箱" placeholderTextColor={colors.secondary} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="emailAddress" style={styles.input} />
        <TextInput accessibilityLabel="密码" editable={!busy} value={password} onChangeText={setPassword} placeholder="密码" placeholderTextColor={colors.secondary} secureTextEntry autoComplete="current-password" textContentType="password" style={styles.input} onSubmitEditing={submit} />
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy || !email.trim() || !password, busy: active === 'email' }} aria-disabled={Platform.OS === 'web' ? busy || !email.trim() || !password : undefined} aria-busy={Platform.OS === 'web' ? active === 'email' : undefined} disabled={busy || !email.trim() || !password} onPress={submit} style={({ pressed }) => [styles.submit, (busy || !email.trim() || !password) && { opacity: 0.4 }, pressed && { opacity: 0.85 }]}>
          <Text style={styles.submitText}>{active === 'email' ? '登录中' : '登录'}</Text>
        </Pressable>
      </View>
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
