import { type ReactNode, useEffect, useState } from 'react'
import { Linking, Pressable, StyleSheet, View } from 'react-native'
import * as Application from 'expo-application'
import * as Updates from 'expo-updates'
import { Spinner } from '@/components/icons'
import { Text } from '@/components/Text'
import { API_URL } from '@/lib/config'
import { buildTooOld, CHECK_MS, DOWNLOAD_MS, within } from '@/lib/startup'
import { colors } from '@/lib/theme'

type Launch = { kind: 'checking' | 'updating' | 'ready' } | { kind: 'tooOld'; url: string }

/** `GET /api/version`: the oldest native build Mikka accepts, and where a newer one is. */
async function versionInfo(): Promise<{ minMobileBuild?: unknown; mobileUpdateUrl?: unknown } | null> {
  const response = await fetch(`${API_URL}/api/version`, { headers: { accept: 'application/json' } })
  return response.ok ? response.json() : null
}

/**
 * Launch (a cold start; the app's own state is never touched while it runs):
 * a build older than Mikka's minimum stops at 「请更新到最新版」 with 更新 to
 * TestFlight and no way past it; a newer OTA update downloads under
 * 「正在更新」 and the app reopens on it. Offline, or past the time limits
 * (lib/startup.ts), the person goes straight in.
 */
export function StartupGate({ children }: { children: ReactNode }) {
  const [launch, setLaunch] = useState<Launch>({ kind: 'checking' })
  useEffect(() => {
    let live = true
    const set = (next: Launch) => { if (live) setLaunch(next) }
    void (async () => {
      const ota = Updates.isEnabled && !__DEV__
        ? within(Updates.checkForUpdateAsync().then(result => result.isAvailable), CHECK_MS, false)
        : Promise.resolve(false)
      const version = await within(versionInfo(), CHECK_MS, null)
      if (buildTooOld(Application.nativeBuildVersion, version?.minMobileBuild)) {
        return set({ kind: 'tooOld', url: typeof version?.mobileUpdateUrl === 'string' ? version.mobileUpdateUrl : 'itms-beta://' })
      }
      if (await ota) {
        set({ kind: 'updating' })
        // The launch's own background check may have fetched it first (isNew is then false); either way the newest download opens.
        if (await within(Updates.fetchUpdateAsync().then(() => true), DOWNLOAD_MS, false)) {
          try { await Updates.reloadAsync(); return } catch { /* opens on the running version */ }
        }
      }
      set({ kind: 'ready' })
    })()
    return () => { live = false }
  }, [])

  if (launch.kind === 'ready') return children
  if (launch.kind === 'tooOld') {
    const url = launch.url
    return (
      <View style={styles.screen}>
        <Text style={styles.title}>请更新到最新版</Text>
        <Pressable accessibilityRole="button" onPress={() => void Linking.openURL(url).catch(() => undefined)} style={({ pressed }) => [styles.button, pressed && { opacity: 0.7 }]}>
          <Text style={styles.buttonText}>更新</Text>
        </Pressable>
      </View>
    )
  }
  return (
    <View style={styles.screen}>
      <Spinner size={22} />
      {launch.kind === 'updating' ? <Text style={styles.status}>正在更新</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, backgroundColor: colors.page, paddingHorizontal: 32 },
  status: { fontSize: 15, color: colors.secondary },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700', color: colors.ink, textAlign: 'center' },
  button: { marginTop: 10, height: 50, minWidth: 200, paddingHorizontal: 28, borderRadius: 25, backgroundColor: colors.accentFill, alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontSize: 17, fontWeight: '600', color: colors.onAccent },
})
