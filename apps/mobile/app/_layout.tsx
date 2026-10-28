import { useEffect } from 'react'
import { Platform, View } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { DrawerHost } from '@/components/Drawer'
import { Spinner } from '@/components/icons'
import { SignIn } from '@/components/SignIn'
import { authClient } from '@/lib/auth'
import { HomeProvider } from '@/lib/home'
import { colors } from '@/lib/theme'

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <SessionGate />
    </SafeAreaProvider>
  )
}

/** Signed out: the sign-in screen. Signed in: the app, and this phone registers for pushes. */
function SessionGate() {
  const { data, isPending } = authClient.useSession()
  if (isPending && !data) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.page }}><Spinner size={22} /></View>
  if (!data?.user) return <SignIn />
  return (
    <HomeProvider>
      <PushSetup />
      <DrawerHost>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.page }, animation: 'slide_from_right' }}>
          <Stack.Screen name="settings" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
        </Stack>
      </DrawerHost>
    </HomeProvider>
  )
}

function PushSetup() {
  const router = useRouter()
  useEffect(() => {
    if (Platform.OS === 'web') return
    let cleanup: (() => void) | undefined
    void import('@/lib/push').then(push => {
      push.registerForPush().catch(() => undefined)
      cleanup = push.onPushOpened(botId => router.push(botId ? `/bots/${botId}` : '/'))
    })
    return () => cleanup?.()
  }, [router])
  return null
}
