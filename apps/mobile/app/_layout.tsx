import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { DrawerHost } from '@/components/Drawer'
import { colors } from '@/lib/theme'

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <DrawerHost>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.page }, animation: 'slide_from_right' }}>
          <Stack.Screen name="settings" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
        </Stack>
      </DrawerHost>
    </SafeAreaProvider>
  )
}
