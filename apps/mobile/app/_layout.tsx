import '../global.css'

import { useEffect } from 'react'
import { Platform, View } from 'react-native'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { DrawerHost } from '@/components/Drawer'
import { Spinner } from '@/components/icons'
import { SignIn } from '@/components/SignIn'
import { authClient } from '@/lib/auth'
import { HomeProvider } from '@/lib/home'
import { openPush } from '@/lib/navigate'
import { colors, screenOptions } from '@/lib/theme'

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <StatusBar style="dark" />
          <SessionGate />
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}

/** Signed out: the sign-in screen. Signed in: the app, and this phone's pushes (PushSetup). */
function SessionGate() {
  const { data, isPending } = authClient.useSession()
  if (isPending && !data) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.page }}><Spinner size={22} /></View>
  if (!data?.user) return <SignIn />
  return (
    <HomeProvider>
      <PushSetup />
      <DrawerHost>
        <Stack screenOptions={screenOptions(colors.page)}>
          <Stack.Screen name="settings" options={{ presentation: 'modal', headerShown: false, ...(Platform.OS === 'ios' ? {} : { animation: 'slide_from_bottom' }) }} />
        </Stack>
      </DrawerHost>
    </HomeProvider>
  )
}

/**
 * Pushes, once signed in: a tap opens what it was about (also a tap that
 * launched the app), and iOS's permission is read but not asked for here; the
 * app asks after the Coordinator's first message of its own, or from 通知.
 */
function PushSetup() {
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
