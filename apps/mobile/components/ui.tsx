import { type ReactNode, useState } from 'react'
import { Image, Platform, Pressable, StyleSheet, TextInput, View, type StyleProp, type ViewStyle } from 'react-native'
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect'
import { KeyboardStickyView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowUp, ChevronLeft, FileText, X } from 'lucide-react-native'
import { AttachMenu, type AttachSource } from '@/components/AttachMenu'
import { Text } from '@/components/Text'
import { MAX_IMAGES, pickImages, pickText, type Attachment } from '@/lib/attachments'
import { tap } from '@/lib/haptics'
import { colors, font, lift } from '@/lib/theme'

const glass = Platform.OS === 'ios' && isLiquidGlassAvailable()

/**
 * A round floating button (the drawer's search, the web bar's buttons). On
 * iOS 26 it is the system's interactive Liquid Glass; earlier iOS and the web
 * draw a white circle with a soft lift.
 */
export function RoundButton({ onPress, children, label, dot }: { onPress?: () => void; children: ReactNode; label: string; dot?: boolean }) {
  if (glass) {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={6}>
        <GlassView isInteractive style={styles.glassRound}>{children}</GlassView>
        {dot ? <View style={styles.dot} /> : null}
      </Pressable>
    )
  }
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={6}
      style={({ pressed }) => [styles.round, pressed && { backgroundColor: colors.pressed }]}>
      {children}
      {dot ? <View style={styles.dot} /> : null}
    </Pressable>
  )
}

export function BackButton({ onPress }: { onPress: () => void }) {
  return <RoundButton label="返回" onPress={onPress}><ChevronLeft size={22} color={colors.ink} strokeWidth={2.2} /></RoundButton>
}

export function CloseButton({ onPress }: { onPress: () => void }) {
  return <RoundButton label="关闭" onPress={onPress}><X size={20} color={colors.ink} strokeWidth={2.2} /></RoundButton>
}

/** Top bar: left button, centred title (or a pill), right button. Floats over the content, no bar background. */
export function Header({ left, title, right, subtitle, style }: { left?: ReactNode; title?: ReactNode; right?: ReactNode; subtitle?: string; style?: StyleProp<ViewStyle> }) {
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.header, { paddingTop: insets.top + 8 }, style]}>
      <View style={styles.side}>{left}</View>
      <View style={styles.titleBox}>
        {typeof title === 'string' ? <Text style={styles.title} numberOfLines={1}>{title}</Text> : title}
        {subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      <View style={[styles.side, { alignItems: 'flex-end' }]}>{right}</View>
    </View>
  )
}

/**
 * The composer: a multi-line field holding the text and send, with 「+」 to
 * its left when the chat takes attachments (`attach`). It rides on the
 * keyboard (react-native-keyboard-controller) and grows to six lines. Picked
 * photos and files wait as thumbnails above the field; each can be removed.
 * The text and attachments stay until `onSend` resolves true (the server took
 * them), so a failed send loses nothing. Controlled when `value` and
 * `onChangeText` are passed.
 */
export function Composer({ placeholder, onSend, initial = '', disabled = false, value, onChangeText, attach = false, overlay = false, onHeight }: {
  placeholder: string
  onSend?: (text: string, attachments: Attachment[]) => boolean | void | Promise<boolean | void>
  initial?: string
  disabled?: boolean
  value?: string
  onChangeText?: (text: string) => void
  attach?: boolean
  /** Float over the end of the list, the content fading out beneath it; `onHeight` reports its height so the list leaves room. */
  overlay?: boolean
  onHeight?: (height: number) => void
}) {
  const insets = useSafeAreaInsets()
  const [own, setOwn] = useState(initial)
  const [sending, setSending] = useState(false)
  const [files, setFiles] = useState<Attachment[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const text = value ?? own
  const setText = onChangeText ?? setOwn
  const blocked = disabled || sending
  const images = files.filter(file => file.kind === 'image').length
  const empty = !text.trim() && !files.length
  const send = async () => {
    if (empty || blocked) return
    setSending(true)
    tap()
    try {
      const ok = await onSend?.(text.trim(), files)
      if (ok !== false) { setText(''); setFiles([]) }
    } finally {
      setSending(false)
    }
  }
  const pick = async (source: AttachSource) => {
    setProblem(null)
    try {
      if (source === 'file') {
        const file = await pickText()
        if (file === 'notText') setProblem('只能发文本文件')
        else if (file === 'tooLong') setProblem('文件太长')
        else if (file) setFiles(list => [...list, file])
        return
      }
      const picked = await pickImages(source, MAX_IMAGES - images)
      if (picked) setFiles(list => [...list, ...picked])
    } catch {
      setProblem('没能添加')
    }
  }
  return (
    <KeyboardStickyView offset={{ opened: Math.max(insets.bottom, 12) - 8 }} style={overlay ? styles.overlay : undefined}>
      <View onLayout={event => onHeight?.(event.nativeEvent.layout.height)} style={[styles.composerWrap, overlay && styles.fade, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        {files.length || problem ? (
          <View style={styles.tray}>
            {files.map(file => (
              <View key={file.key} style={file.kind === 'image' ? styles.thumb : styles.fileChip}>
                {file.kind === 'image'
                  ? <Image source={{ uri: file.uri }} style={styles.thumbImage} accessibilityLabel="照片" />
                  : <><FileText size={16} color={colors.ink} strokeWidth={1.8} /><Text style={styles.fileName} numberOfLines={1}>{file.name}</Text></>}
                <Pressable accessibilityRole="button" accessibilityLabel="移除" hitSlop={8} onPress={() => setFiles(list => list.filter(item => item.key !== file.key))} style={styles.remove}>
                  <X size={12} color="#fff" strokeWidth={3} />
                </Pressable>
              </View>
            ))}
            {problem ? <Text style={styles.problem}>{problem}</Text> : null}
          </View>
        ) : null}
        <View style={styles.composerRow}>
          {attach ? <AttachMenu images={images < MAX_IMAGES} onPick={source => void pick(source)} /> : null}
          <Field style={styles.field}>
            <TextInput value={text} onChangeText={setText} placeholder={placeholder} editable={!blocked} multiline
              placeholderTextColor={colors.tertiary} style={[styles.input, sending && { color: colors.secondary }]} />
            <Pressable accessibilityRole="button" accessibilityLabel="发送" accessibilityState={{ disabled: blocked || empty }} onPress={() => void send()} disabled={blocked}
              style={[styles.send, (blocked || empty) && { backgroundColor: colors.tertiary }]}>
              <ArrowUp size={20} color="#fff" strokeWidth={2.4} />
            </Pressable>
          </Field>
        </View>
      </View>
    </KeyboardStickyView>
  )
}

/** A capsule for the bar's title (the bot's name): Liquid Glass on iOS 26, white with a lift elsewhere. */
export function Capsule({ children }: { children: ReactNode }) {
  return glass
    ? <GlassView style={styles.capsule}>{children}</GlassView>
    : <View style={[styles.capsule, { backgroundColor: '#fff' }, lift]}>{children}</View>
}

/** A field's surface (the composer, the drawer's search): Liquid Glass on iOS 26, white with a lift elsewhere. */
export function Field({ style, children }: { style: StyleProp<ViewStyle>; children: ReactNode }) {
  return glass ? <GlassView style={[style, { backgroundColor: undefined }]}>{children}</GlassView> : <View style={[style, lift]}>{children}</View>
}

/** Grouped list section, iOS inset style, no outline. */
export function Group({ label, children }: { label?: string; children: ReactNode }) {
  const items = (Array.isArray(children) ? children : [children]).flat().filter(Boolean)
  return (
    <View style={{ marginBottom: 20 }}>
      {label ? <Text style={styles.groupLabel}>{label}</Text> : null}
      <View style={styles.group}>
        {items.map((child, index) => (
          <View key={index}>
            {index > 0 ? <View style={styles.separator} /> : null}
            {child}
          </View>
        ))}
      </View>
    </View>
  )
}

export function Dot({ color = colors.unread }: { color?: string }) {
  return <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: color }} />
}

const styles = StyleSheet.create({
  round: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...lift },
  dot: { position: 'absolute', top: 8, right: 9, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.unread, borderWidth: 1.5, borderColor: '#fff' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 8, zIndex: 10 },
  side: { width: 64 },
  titleBox: { flex: 1, alignItems: 'center' },
  title: { fontSize: 17, fontWeight: '600' },
  subtitle: { fontSize: 11, color: colors.secondary, marginTop: 1 },
  glassRound: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  composerWrap: { paddingHorizontal: 16, paddingTop: 10, gap: 8 },
  overlay: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  // What scrolls under the composer fades out, as under the iOS bar at the top.
  fade: { paddingTop: 28, backgroundImage: 'linear-gradient(to bottom, rgba(255,255,255,0) 0%, rgba(255,255,255,0.85) 45%, rgba(255,255,255,0.97) 100%)' },
  capsule: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 40, paddingHorizontal: 16, borderRadius: 20, maxWidth: 220 },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  field: { flex: 1, flexDirection: 'row', alignItems: 'flex-end', minHeight: 52, borderRadius: 26, backgroundColor: '#fff', paddingLeft: 18, paddingRight: 6, paddingVertical: 6, gap: 10 },
  // Six lines of 22, then it scrolls.
  input: { flex: 1, minWidth: 0, width: 0, maxHeight: 6 * 22 + 16, fontFamily: font, fontSize: 16, lineHeight: 22, color: colors.text, paddingTop: 9, paddingBottom: 9, outlineStyle: 'none' } as never,
  tray: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  thumb: { width: 64, height: 64, borderRadius: 14 },
  thumbImage: { width: 64, height: 64, borderRadius: 14, backgroundColor: colors.bubble },
  fileChip: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 40, maxWidth: 200, paddingLeft: 12, paddingRight: 22, borderRadius: 14, backgroundColor: colors.bubble },
  fileName: { fontSize: 14, flexShrink: 1 },
  remove: { position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: 10, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  problem: { fontSize: 13, color: colors.danger },
  send: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  groupLabel: { fontSize: 13, color: colors.secondary, marginLeft: 16, marginBottom: 7 },
  group: { backgroundColor: colors.surface, borderRadius: 14, overflow: 'hidden' },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.separator, marginLeft: 16 },
})
