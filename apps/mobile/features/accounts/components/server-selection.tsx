import { useEffect, useRef, useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import { Server } from 'lucide-react-native'
import { Text } from '@/components/Text'
import { Symbol } from '@/components/Symbol'
import { Segmented } from '@/components/Segmented'
import { CardButton } from '@/components/cards'
import { currentAccount, defaultServer } from '@/lib/config'
import { connectMobileServer } from '@/lib/server-actions'
import { probeMobileServer, type ServerProbe } from '@/lib/server-discovery'
import { probeError, serverCopy as copy } from '@/lib/server-copy'
import { mobileAppVersion } from '@/lib/tracing'
import { colors, font } from '@/lib/theme'

/** A small extension of the existing sign-in screen; all controls are shared. */
export function ServerSelection({ choosing, setChoosing, disabled }: { choosing: boolean; setChoosing(value: boolean): void; disabled: boolean }) {
  const account = currentAccount()
  const [mode, setMode] = useState<'cloud' | 'self'>(account.server.url === defaultServer.url ? 'cloud' : 'self')
  const [address, setAddress] = useState(mode === 'self' ? account.server.url : '')
  const [probe, setProbe] = useState<ServerProbe | 'checking' | null>(null)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => pending.current?.abort(), [])
  const reset = () => { pending.current?.abort(); pending.current = null; setProbe(null); setFailed(false) }
  const check = async () => {
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    setProbe('checking'); setFailed(false)
    const found = await probeMobileServer(mode === 'cloud' ? defaultServer.url : address, { fetch, appVersion: mobileAppVersion, signal: controller.signal })
      .catch(() => ({ status: 'unreachable' } as const))
    if (!controller.signal.aborted) setProbe(found)
  }
  const connect = async () => {
    if (saving || !probe || probe === 'checking' || probe.status !== 'ok') return
    setSaving(true); setFailed(false)
    try { await connectMobileServer(probe.server); setChoosing(false) }
    catch { setFailed(true) }
    finally { setSaving(false) }
  }
  const summary = (name: string, version: string | null) => <View style={styles.row}>
    <Symbol name="server.rack" size={18} color={colors.secondary} web={<Server size={18} color={colors.secondary} />} />
    <View style={{ flex: 1, gap: 4 }}>
      <Text selectable style={styles.name}>{name}</Text>
      {version ? <Text selectable style={styles.version}>{copy.version.replace('{version}', version)}</Text> : null}
    </View>
  </View>
  if (!choosing) return <View style={styles.row}>
    <View style={{ flex: 1 }}>{summary(account.server.name, account.server.version)}</View>
    <CardButton label={copy.change} disabled={disabled} onPress={() => { reset(); setChoosing(true) }} />
  </View>
  return <View style={{ gap: 14 }}>
    <Text style={styles.name}>{copy.title}</Text>
    <View pointerEvents={saving ? 'none' : 'auto'}>
      <Segmented options={[{ value: 'cloud', label: copy.cloud }, { value: 'self', label: copy.selfHosted }]} value={mode} onChange={next => { reset(); setMode(next) }} />
    </View>
    {mode === 'self' ? <TextInput accessibilityLabel={copy.address} editable={!saving} value={address}
      onChangeText={next => { reset(); setAddress(next) }} placeholder="https://mikka.example.com" placeholderTextColor={colors.secondary}
      autoCapitalize="none" autoCorrect={false} keyboardType="url" textContentType="URL" returnKeyType="go"
      onSubmitEditing={() => void check()} style={styles.input} /> : null}
    {probe && probe !== 'checking' && probe.status === 'ok' ? <>
      {summary(probe.server.name, probe.server.version)}
      <CardButton label={saving ? copy.saving : copy.continue} primary busy={saving} onPress={() => void connect()} />
    </> : <>
      <CardButton label={probe === 'checking' ? copy.connecting : copy.connect} primary busy={probe === 'checking'} disabled={saving || mode === 'self' && !address.trim()} onPress={() => void check()} />
      {probe && probe !== 'checking' ? <Text selectable accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{probeError(probe)}</Text> : null}
    </>}
    {failed ? <Text selectable accessibilityRole="alert" style={styles.error}>{copy.saveFailed}</Text> : null}
    <CardButton label={copy.cancel} disabled={saving} onPress={() => { reset(); setChoosing(false) }} />
  </View>
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  name: { fontSize: 16, fontWeight: '600' },
  version: { fontSize: 13, color: colors.secondary },
  input: { minHeight: 52, paddingVertical: 14, borderRadius: 14, backgroundColor: colors.bubble, paddingHorizontal: 16, fontSize: 16, fontFamily: font, color: colors.text, outlineStyle: 'none' } as never,
  error: { color: colors.danger, fontSize: 13 },
})
