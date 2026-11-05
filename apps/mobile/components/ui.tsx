import { Children, type ReactNode, useEffect, useRef, useState } from 'react'
import { Image, Platform, Pressable, StyleSheet, TextInput, useColorScheme, View, type StyleProp, type TextInputInstance, type ViewStyle } from 'react-native'
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect'
import { KeyboardStickyView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowUp, ChevronLeft, FileText, RotateCw, Square, X } from 'lucide-react-native'
import { AttachMenu, type AttachSource } from '@/components/AttachMenu'
import { Text } from '@/components/Text'
import { Spinner } from '@/components/icons'
import { MAX_IMAGES, pickImages, pickText, pickChatFile, uploadPickedFile, pastedChatImage, type Attachment } from '@/lib/attachments'
import { withChatFiles, CHAT_FILE_MAX_COUNT, type ChatFileScope } from '@mikka/protocol/chat-attachments'
import { api } from '@/lib/api'
import { tap } from '@/lib/haptics'
import { colors, font, lift, plainColor } from '@/lib/theme'

const glass = Platform.OS === 'ios' && isLiquidGlassAvailable()

/**
 * A round floating button (the drawer's search, the web bar's buttons). On
 * iOS 26 it is the system's interactive Liquid Glass; earlier iOS and the web
 * draw a white circle with a soft lift.
 */
export function RoundButton({ onPress, children, label, dot, disabled = false, busy = false }: { onPress?: () => void; children: ReactNode; label: string; dot?: boolean; disabled?: boolean; busy?: boolean }) {
  const blocked = disabled || busy
  const content = busy ? <Spinner size={20} color={colors.ink} /> : children
  if (glass) {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: blocked, busy }} aria-disabled={Platform.OS === 'web' ? blocked : undefined} aria-busy={Platform.OS === 'web' ? busy : undefined} disabled={blocked} onPress={onPress} style={blocked ? { opacity: 0.4 } : undefined}>
        <GlassView isInteractive={!blocked} style={styles.glassRound}>{content}</GlassView>
        {dot ? <View style={styles.dot} /> : null}
      </Pressable>
    )
  }
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: blocked, busy }} aria-disabled={Platform.OS === 'web' ? blocked : undefined} aria-busy={Platform.OS === 'web' ? busy : undefined} disabled={blocked} onPress={onPress}
      style={({ pressed }) => [styles.round, blocked && { opacity: 0.4 }, pressed && { backgroundColor: colors.pressed }]}>
      {content}
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
  const count = Math.max(1, Children.count(left), Children.count(right))
  const sideWidth = count * 44 + (count - 1) * 8
  return (
    <View style={[styles.header, { paddingTop: insets.top + 8 }, style]}>
      <View style={[styles.side, { width: sideWidth }]}>{left}</View>
      <View style={styles.titleBox}>
        {typeof title === 'string' ? <Text style={styles.title} numberOfLines={1}>{title}</Text> : title}
        {subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      <View style={[styles.side, { width: sideWidth, justifyContent: 'flex-end' }]}>{right}</View>
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
export function Composer({ placeholder, onSend, initial = '', disabled = false, sendDisabled = false, value, onChangeText, attach = false, overlay = false, onHeight, autoFocus = false, quote, onClearQuote, accessory, notice, onStop, attachmentScope }: {
  placeholder: string
  onSend?: (text: string, attachments: Attachment[]) => boolean | void | Promise<boolean | void>
  initial?: string
  disabled?: boolean
  /** Only sending is unavailable; editing, attachments, model controls and stop stay available. */
  sendDisabled?: boolean
  value?: string
  onChangeText?: (text: string) => void
  attach?: boolean
  attachmentScope?: ChatFileScope
  /** Float over the end of the list, the content fading out beneath it; `onHeight` reports its height so the list leaves room. */
  overlay?: boolean
  onHeight?: (height: number) => void
  /** Open the keyboard on arrival (新线程, 新建, a 建议 draft). */
  autoFocus?: boolean
  /** A message being quoted (swiped right in the chat): shown above the words and sent ahead of them as a Markdown quote. */
  quote?: string | null
  onClearQuote?: () => void
  /** Beside 「+」 in the field's bottom row (the model menu). */
  accessory?: ReactNode
  /** A line above the field, e.g. a model pick that did not save (ModelNotice). */
  notice?: ReactNode
  /** While the bot answers: send turns into stop until something is typed. */
  onStop?: () => void
}) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light'
  const input = useRef<TextInputInstance>(null)
  // A new quote is something to answer: the keyboard comes up.
  useEffect(() => { if (quote) input.current?.focus() }, [quote])
  const insets = useSafeAreaInsets()
  const [own, setOwn] = useState(initial)
  const [sending, setSending] = useState(false)
  const [files, setFiles] = useState<Attachment[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const scopeKey = attachmentScope ? `${attachmentScope.kind}:${attachmentScope.id}` : ''
  const currentScope = useRef(scopeKey)
  currentScope.current = scopeKey
  useEffect(() => { setFiles([]); setProblem(null) }, [scopeKey])
  const text = value ?? own
  const setText = onChangeText ?? setOwn
  const blocked = disabled || sending
  const filesBlocked = files.some(file => file.kind === 'file' && file.state !== 'ready')
  const images = files.filter(file => file.kind === 'image').length
  const empty = !text.trim() && !files.length
  const sendBlocked = blocked || filesBlocked || empty || sendDisabled
  const quoted = (words: string) => quote ? `${quote.split('\n').map(line => `> ${line}`).join('\n')}\n\n${words}` : words
  const send = async () => {
    if (sendBlocked) return
    setSending(true)
    tap()
    try {
      const ready = files.flatMap(file => file.kind === 'file' && file.uploaded ? [file.uploaded] : [])
      const ok = await onSend?.(withChatFiles(quoted(text.trim()), ready), files.filter(file => file.kind !== 'file'))
      if (ok !== false) { setText(''); setFiles([]); onClearQuote?.() }
    } finally {
      setSending(false)
    }
  }
  const upload = async (item: Extract<Attachment, { kind: 'file' }>) => {
    if (!attachmentScope || blocked) return
    const original = scopeKey
    setFiles(list => [...list.filter(file => file.key !== item.key), { ...item, state: 'uploading', error: undefined }])
    try {
      const uploaded = await uploadPickedFile(item, attachmentScope)
      if (currentScope.current === original) setFiles(list => list.map(file => file.key === item.key ? { ...item, uploaded, state: 'ready' } : file))
    } catch (error) {
      const message = error instanceof Error && error.message === 'audioKeyRequired' ? '请先添加可用的 OpenAI API Key' : '上传失败'
      if (currentScope.current === original) setFiles(list => list.map(file => file.key === item.key ? { ...item, state: 'error', error: message } : file))
    }
  }
  const pick = async (source: AttachSource) => {
    if (blocked) return
    setProblem(null)
    try {
      if (attachmentScope && files.length >= CHAT_FILE_MAX_COUNT) { setProblem('最多添加 10 个文件'); return }
      if (source === 'file') {
        if (attachmentScope) { const item = await pickChatFile(); if (item) void upload(item); return }
        const file = await pickText()
        if (file === 'notText') setProblem('只能发文本文件')
        else if (file === 'tooLong') setProblem('文件太长')
        else if (file) setFiles(list => [...list, file])
        return
      }
      const picked = await pickImages(source, attachmentScope ? Math.min(MAX_IMAGES, CHAT_FILE_MAX_COUNT - files.length) : MAX_IMAGES - images)
      if (picked && attachmentScope) {
        for (const photo of picked) if (photo.kind === 'image') void upload({ key: photo.key, kind: 'file', name: `photo-${photo.key}.jpg`, uri: photo.uri, mediaType: 'image/jpeg', size: Math.floor((photo.dataUrl.split(',')[1]?.length ?? 0) * 3 / 4), state: 'uploading' })
      } else if (picked) setFiles(list => [...list, ...picked])
    } catch {
      setProblem('无法添加文件')
    }
  }
  return (
    <KeyboardStickyView offset={{ opened: Math.max(insets.bottom, 12) - 8 }} style={overlay ? styles.overlay : undefined}>
      <View onLayout={event => onHeight?.(event.nativeEvent.layout.height)} style={[styles.composerWrap, overlay && fade(scheme), { paddingBottom: Math.max(insets.bottom, 12) }]}>
        {files.length || problem ? (
          <View style={styles.tray}>
            {files.map(file => (
              <View key={file.key} style={file.kind === 'image' ? styles.thumb : styles.fileChip}>
                {file.kind === 'image'
                  ? <Image source={{ uri: file.uri }} style={styles.thumbImage} accessibilityLabel="照片" />
                  : <><FileText size={16} color={colors.ink} strokeWidth={1.8} /><View style={{ flex: 1, minWidth: 0 }}><Text style={styles.fileName} numberOfLines={1}>{file.name}</Text>{file.kind === 'file' ? <Text numberOfLines={1} style={styles.problem}>{file.state === 'uploading' ? '上传中' : file.state === 'error' ? file.error : `${Math.ceil(file.size / 1024)} KB`}</Text> : null}</View>{file.kind === 'file' && file.state === 'error' ? <Pressable accessibilityRole="button" accessibilityLabel={`重试上传 ${file.name}`} accessibilityState={{ disabled: blocked }} aria-disabled={Platform.OS === 'web' ? blocked : undefined} style={styles.attachmentAction} disabled={blocked} onPress={() => void upload(file)}><RotateCw size={16} color={colors.secondary} /></Pressable> : null}</>}
                <Pressable accessibilityRole="button" accessibilityLabel={file.kind === 'image' ? '移除照片' : `移除 ${file.name}`} accessibilityState={{ disabled: blocked }} aria-disabled={Platform.OS === 'web' ? blocked : undefined} disabled={blocked} onPress={() => { if (blocked) return; setFiles(list => list.filter(item => item.key !== file.key)); if (file.kind === 'file' && file.uploaded) void api(`/api/chat/attachments/${file.uploaded.id}`, { method: 'DELETE' }).catch(() => {}) }} style={styles.remove}>
                  <View style={styles.removeMark}><X size={12} color={colors.onInk} strokeWidth={3} /></View>
                </Pressable>
              </View>
            ))}
            {problem ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.problem}>{problem}</Text> : null}
          </View>
        ) : null}
        {notice}
        {/* One field, as in the Claude app: the quote, the words, then 「+」 and send. */}
        <Field style={styles.field}>
          {quote ? (
            <View style={styles.quote}>
              <Text style={styles.quoteText} numberOfLines={1}>{quote.replace(/\s+/g, ' ')}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="取消引用" style={styles.attachmentAction} onPress={onClearQuote}>
                <X size={16} color={colors.secondary} strokeWidth={2.2} />
              </Pressable>
            </View>
          ) : null}
          <TextInput ref={input} accessibilityLabel={placeholder} value={text} onChangeText={setText} placeholder={placeholder} editable={!blocked} multiline autoFocus={autoFocus}
            placeholderTextColor={colors.secondary} style={[styles.input, sending && { color: colors.secondary }]} />
          <View style={styles.fieldRow}>
            {attach ? <AttachMenu images={attachmentScope ? files.length < CHAT_FILE_MAX_COUNT : images < MAX_IMAGES} onPick={pick} onPasteImage={attachmentScope ? async image => { if (!blocked && files.length < CHAT_FILE_MAX_COUNT) { try { void upload(await pastedChatImage(image)) } catch { setProblem('无法粘贴图片') } } } : undefined} /> : null}
            {accessory}
            <View style={{ flex: 1 }} />
            {onStop && empty && !sending ? (
              <Pressable accessibilityRole="button" accessibilityLabel="停止" onPress={() => { tap(); onStop() }} style={styles.send}>
                <Square size={14} color={colors.onAccent} fill={colors.onAccent} strokeWidth={2.4} />
              </Pressable>
            ) : (
              <Pressable accessibilityRole="button" accessibilityLabel="发送" accessibilityState={{ disabled: sendBlocked, busy: sending }} aria-disabled={Platform.OS === 'web' ? sendBlocked : undefined} aria-busy={Platform.OS === 'web' ? sending : undefined} onPress={() => void send()} disabled={sendBlocked}
                style={[styles.send, sendBlocked && { backgroundColor: colors.tertiary }]}>
                <ArrowUp size={20} color={colors.onAccent} strokeWidth={2.4} />
              </Pressable>
            )}
          </View>
        </Field>
      </View>
    </KeyboardStickyView>
  )
}

/** A capsule for the bar's title (the bot's name): Liquid Glass on iOS 26, white with a lift elsewhere. */
export function Capsule({ children }: { children: ReactNode }) {
  return glass
    ? <GlassView style={styles.capsule}>{children}</GlassView>
    : <View style={[styles.capsule, { backgroundColor: colors.surface }, lift]}>{children}</View>
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

/** The composer's fade over the end of the list, in the page's colour for the scheme (a CSS gradient takes no system colour). */
function fade(scheme: 'light' | 'dark') {
  const page = plainColor('page', scheme)
  return { paddingTop: 28, backgroundImage: `linear-gradient(to bottom, ${page}00 0%, ${page}D9 45%, ${page}F7 100%)` }
}

const styles = StyleSheet.create({
  round: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', ...lift },
  dot: { position: 'absolute', top: 8, right: 9, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.unread, borderWidth: 1.5, borderColor: colors.surface },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 8, zIndex: 10 },
  side: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  titleBox: { flex: 1, minWidth: 0, alignItems: 'center' },
  title: { fontSize: 17, fontWeight: '600' },
  subtitle: { fontSize: 11, color: colors.secondary, marginTop: 1 },
  glassRound: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  composerWrap: { paddingHorizontal: 16, paddingTop: 10, gap: 8 },
  overlay: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  // What scrolls under the composer fades out, as under the iOS bar at the top.
  capsule: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 22, maxWidth: 220 },
  field: { borderRadius: 26, backgroundColor: colors.surface, paddingHorizontal: 8, paddingTop: 8, paddingBottom: 8, gap: 4 },
  fieldRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  quote: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 4, paddingLeft: 14, paddingRight: 0, minHeight: 44, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separator },
  quoteText: { flex: 1, minWidth: 0, fontSize: 14, color: colors.secondary },
  // Six lines of 22, then it scrolls.
  input: { minHeight: 40, maxHeight: 6 * 22 + 16, paddingHorizontal: 10, fontFamily: font, fontSize: 16, lineHeight: 22, color: colors.text, paddingTop: 9, paddingBottom: 9, outlineStyle: 'none' } as never,
  tray: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  thumb: { width: 64, height: 64, borderRadius: 14 },
  thumbImage: { width: 64, height: 64, borderRadius: 14, backgroundColor: colors.bubble },
  fileChip: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, maxWidth: 280, paddingLeft: 12, paddingRight: 44, paddingVertical: 8, borderRadius: 14, backgroundColor: colors.bubble },
  fileName: { fontSize: 14, flexShrink: 1 },
  remove: { position: 'absolute', top: 0, right: 0, width: 44, height: 44, alignItems: 'flex-end', justifyContent: 'flex-start', padding: 4 },
  removeMark: { width: 20, height: 20, borderRadius: 10, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  attachmentAction: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  problem: { fontSize: 13, color: colors.danger },
  send: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.accentFill, alignItems: 'center', justifyContent: 'center' },
  groupLabel: { fontSize: 13, color: colors.secondary, marginLeft: 16, marginBottom: 7 },
  group: { backgroundColor: colors.surface, borderRadius: 14, overflow: 'hidden' },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.separator, marginLeft: 16 },
})
