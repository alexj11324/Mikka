import '../global.css'

import { useEffect, useState } from 'react'
import { Platform, useColorScheme, View } from 'react-native'
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { HeroUINativeProvider } from 'heroui-native/provider'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { Spinner } from '@/components/icons'
import { SignIn } from '@/components/SignIn'
import { StartupGate } from '@/components/StartupGate'
import { ServerGate } from '@/components/ServerGate'
import { Text } from '@/components/Text'
import { CardButton } from '@/components/cards'
import { authClient } from '@/lib/auth'
import { watchAppleCredential } from '@/lib/apple-auth'
import { apiCache } from '@/lib/api-cache'
import { HomeProvider } from '@/lib/home'
import { openPush } from '@/lib/navigate'
import { colors, screenOptions } from '@/lib/theme'
import { newSheetOptions, reviewSheetOptions } from '@/lib/sheet-options'
import { conversationJournal, currentAccount, servers } from '@/lib/config'
import { serverCopy as copy } from '@/lib/server-copy'

/** HeroUI Native draws product content (DESIGN.md). Mikka has no toasts: a state shows in place. */
const HERO_UI = { toast: false, devInfo: { stylingPrinciples: false } } as const

export default function RootLayout() {
  // The navigation bar's title, back button and material follow the system's appearance: without a theme the stack
  // draws in its light default, a light bar with dark words on a dark app (#1386).
  const dark = useColorScheme() === 'dark'
  return (
    <ThemeProvider value={dark ? DarkTheme : DefaultTheme}>
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <HeroUINativeProvider config={HERO_UI}>
            <StatusBar style="auto" />
            <ServerGate>{id => <StartupGate key={id}><SessionGate /></StartupGate>}</ServerGate>
          </HeroUINativeProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
    </ThemeProvider>
  )
}

/** Signed out: the sign-in screen. Signed in: the app, and this phone's pushes (PushSetup). */
function SessionGate() {
  const { data, isPending } = authClient.useSession()
  const account = currentAccount()
  const [saveFailed, setSaveFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (data?.user) return watchAppleCredential(account.id)
  }, [account.id, data?.user?.id])
  useEffect(() => {
    let live = true
    setSaveFailed(false)
    if (data?.user) void servers.remember(account.id, { id: data.user.id, name: data.user.name, email: data.user.email }).catch(() => { if (live) setSaveFailed(true) })
    return () => { live = false }
  }, [account.id, data?.user?.id, data?.user?.name, data?.user?.email, attempt])
  // Establish the identity boundary before any child can read a cached answer.
  if (!isPending || data?.session) {
    try { conversationJournal.bind(account.id, data?.session?.id ?? null) } catch { /* The send control reports unavailable storage before writing. */ }
  }
  apiCache.setIdentity(data?.user ? `${account.id}:${data.user.id}` : null, data?.user?.id ?? null, data?.session?.id ?? null)
  if (isPending && !data) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.page }}><Spinner size={22} /></View>
  if (!data?.user) return <SignIn />
  if (account.user?.id !== data.user.id) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, backgroundColor: colors.page }}>
    {saveFailed ? <><Text accessibilityRole="alert">{copy.saveFailed}</Text><CardButton label={copy.retry} onPress={() => setAttempt(value => value + 1)} /></> : <Spinner size={22} />}
  </View>
  return (
    <HomeProvider key={data.user.id}>
      <PushSetup session={data.session?.id ?? null} />
      {/* The tabs (docs/design/mobile-comma-redesign.md); a chat, a thread and the rest are pushed over them, so the
          tab bar goes away there. */}
      <Stack screenOptions={screenOptions(colors.page)}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        {/* A long press on a message: its actions as a system sheet, and 选择文本 over the chat. */}
        <Stack.Screen name="message" options={{ presentation: 'formSheet', sheetAllowedDetents: [0.42], sheetGrabberVisible: true, headerShown: false, contentStyle: { backgroundColor: colors.grouped } }} />
        <Stack.Screen name="attach" options={{ presentation: 'formSheet', sheetAllowedDetents: [0.22], sheetGrabberVisible: true, headerShown: false, contentStyle: { backgroundColor: colors.grouped } }} />
        {/* 新建 Bot and 新建群聊: full-height form sheets with the grabber (docs/design/mobile-comma, 06–07). */}
        <Stack.Screen name="new-task" options={newSheetOptions(colors.page)} />
        <Stack.Screen name="new-bot" options={newSheetOptions(colors.page)} />
        <Stack.Screen name="new-group" options={newSheetOptions(colors.page)} />
        <Stack.Screen name="task/[id]/comment" options={reviewSheetOptions(colors.page)} />
        <Stack.Screen name="task/[id]/batch" options={reviewSheetOptions(colors.page)} />
        <Stack.Screen name="task/[id]/note" options={reviewSheetOptions(colors.page)} />
        <Stack.Screen name="message-text" options={{ presentation: 'modal' }} />
      </Stack>
    </HomeProvider>
  )
}

/**
 * Pushes, once signed in: a tap opens what it was about (also a tap that
 * launched the app), and iOS's permission is read but not asked for here; the
 * app asks after the Coordinator's first message of its own, or from 通知.
 * This phone registers at sign-in, on return to the front and when its
 * session changes (lib/push.ts).
 */
function PushSetup({ session }: { session: string | null }) {
  // Which session this phone is signed in with: the server binds the push token to it, so a new session registers
  // again (#1659). Declared before watchPushes so the first registration already knows it.
  useEffect(() => {
    if (Platform.OS === 'web') return
    void import('@/lib/push').then(push => push.setPushSession(session)).catch(() => undefined)
  }, [session])
  useEffect(() => {
    if (Platform.OS === 'web') return
    let cleanup: (() => void) | undefined
    let gone = false
    void import('@/lib/push').then(push => {
      if (!gone) cleanup = push.watchPushes(openPush)
    })
    return () => { gone = true; cleanup?.() }
  }, [])
  return null
}
