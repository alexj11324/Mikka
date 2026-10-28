import { useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { BotAvatar, SourceIcon } from '@/components/icons'
import { Text } from '@/components/Text'
import { authClient } from '@/lib/auth'
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const run = async (work: () => Promise<{ error?: unknown } | undefined | void>) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const result = await work()
      if (result && 'error' in result && result.error) setError('操作未成功，请检查填写的信息或稍后重试。')
    } catch {
      setError('暂时无法连接，请稍后重试。')
    } finally {
      setBusy(false)
    }
  }

  const social = (provider: 'google' | 'github') => run(() => authClient.signIn.social({ provider, callbackURL: '/' }))
  const submit = () => run(() => authClient.signIn.email({ email: email.trim(), password }))

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[styles.screen, { paddingTop: insets.top + 80, paddingBottom: insets.bottom + 24 }]}>
      <View style={styles.brand}>
        <BotAvatar size={56} />
        <Text style={styles.title}>Mikka</Text>
      </View>
      <View style={{ gap: 10 }}>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => social('google')} style={({ pressed }) => [styles.provider, pressed && styles.pressed]}>
          <SourceIcon source="google" size={20} />
          <Text style={styles.providerText}>使用 Google 继续</Text>
        </Pressable>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => social('github')} style={({ pressed }) => [styles.provider, pressed && styles.pressed]}>
          <SourceIcon source="github" size={20} />
          <Text style={styles.providerText}>使用 GitHub 继续</Text>
        </Pressable>
      </View>
      <Text style={styles.or}>或</Text>
      <View style={{ gap: 10 }}>
        <TextInput value={email} onChangeText={setEmail} placeholder="邮箱" placeholderTextColor={colors.tertiary} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="emailAddress" style={styles.input} />
        <TextInput value={password} onChangeText={setPassword} placeholder="密码" placeholderTextColor={colors.tertiary} secureTextEntry autoComplete="current-password" textContentType="password" style={styles.input} onSubmitEditing={submit} />
        <Pressable accessibilityRole="button" disabled={busy || !email.trim() || !password} onPress={submit} style={({ pressed }) => [styles.submit, (busy || !email.trim() || !password) && { opacity: 0.4 }, pressed && { opacity: 0.85 }]}>
          <Text style={styles.submitText}>登录</Text>
        </Pressable>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page, paddingHorizontal: 24, gap: 18 },
  brand: { alignItems: 'center', gap: 12, marginBottom: 28 },
  title: { fontSize: 30, fontWeight: '700' },
  provider: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, height: 52, borderRadius: 26, backgroundColor: colors.bubble },
  pressed: { backgroundColor: colors.pressed },
  providerText: { fontSize: 16, fontWeight: '600' },
  or: { alignSelf: 'center', color: colors.secondary, fontSize: 13 },
  input: { height: 52, borderRadius: 14, backgroundColor: colors.bubble, paddingHorizontal: 16, fontSize: 16, fontFamily: font, color: colors.text, outlineStyle: 'none' } as never,
  submit: { height: 52, borderRadius: 26, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  error: { color: colors.danger, fontSize: 13, textAlign: 'center' },
})
