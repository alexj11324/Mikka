import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Image, Platform, Pressable, StyleSheet, TextInput, useColorScheme, View, type TextInputInstance, type ViewInstance } from 'react-native'
import { KeyboardStickyView } from 'react-native-keyboard-controller'
import type { ClipboardImage } from 'expo-clipboard'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowUp, FileText, RotateCw, Square, X } from 'lucide-react-native'
import type { AttachSource } from '@/components/AttachMenu'
import { Text } from '@/components/Text'
import { Field } from '@/components/ui'
import { MAX_IMAGES, pickImages, pickText, pickChatFile, uploadPickedFile, pastedChatImage, type Attachment } from '@/lib/attachments'
import { withChatFiles, CHAT_FILE_MAX_COUNT, type ChatFileScope } from '@mikka/protocol/chat-attachments'
import { api } from '@/lib/api'
import { tap } from '@/lib/haptics'
import { mobileMessages } from '@/lib/messages'
import { colors, font, plainColor } from '@/lib/theme'
import { ChatAttachmentCard, ChatAttachmentPlus, useAttachmentCard } from './chat-attachment-card'
import { cardAnchor } from '@/features/chat/model/chat-attachment-card'

/**
 * The composer: a multi-line field holding the text and send, with 「+」 to
 * its left when the chat takes attachments (`attach`). It rides on the
 * keyboard (react-native-keyboard-controller) and grows to six lines. Picked
 * photos and files wait as thumbnails above the field; each can be removed.
 * The text and attachments stay until `onSend` resolves true (the sender took
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
  const sendLock = useRef(false)
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
    if (sendLock.current || sendBlocked) return
    sendLock.current = true
    setSending(true)
    tap()
    try {
      const ready = files.flatMap(file => file.kind === 'file' && file.uploaded ? [file.uploaded] : [])
      const ok = await onSend?.(withChatFiles(quoted(text.trim()), ready), files.filter(file => file.kind !== 'file'))
      if (ok !== false) { setText(''); setFiles([]); onClearQuote?.() }
    } finally {
      sendLock.current = false
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
        if (attachmentScope) {
          const item = await pickChatFile()
          if (typeof item === 'string') setProblem(mobileMessages.Shell.attachments.errors[item])
          else if (item) void upload(item)
          return
        }
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
  const card = useAttachmentCard()
  const wrap = useRef<ViewInstance>(null)
  const canAddImages = attachmentScope ? files.length < CHAT_FILE_MAX_COUNT : images < MAX_IMAGES
  // The card opens on the 「+」's corner: both are measured on screen when it opens (a transform makes later
  // measurements unreliable).
  const openCard = () => {
    const composer = wrap.current, plus = card.plus.current
    if (!composer || !plus) return
    composer.measureInWindow((cx, cy, _cw, ch) => plus.measureInWindow((px, py, _pw, ph) => card.setAnchor(cardAnchor({ x: px, y: py, height: ph }, { x: cx, y: cy, height: ch }))))
  }
  const pasteImage = attachmentScope ? async (image: ClipboardImage) => { if (!blocked && files.length < CHAT_FILE_MAX_COUNT) { try { void upload(await pastedChatImage(image)) } catch { setProblem('无法粘贴图片') } } } : undefined
  return (
    <KeyboardStickyView offset={{ opened: Math.max(insets.bottom, 12) - 8 }} style={overlay ? styles.overlay : undefined}>
      <View ref={wrap} collapsable={false} onLayout={event => onHeight?.(event.nativeEvent.layout.height)} style={[styles.composerWrap, overlay && fade(scheme), { paddingBottom: Math.max(insets.bottom, 12) }]}>
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
            {attach ? <ChatAttachmentPlus ref={card.plus} progress={card.progress} disabled={blocked} onPress={openCard} /> : null}
            {accessory}
            <View style={{ flex: 1 }} />
            {onStop && empty && !sending ? (
              <Pressable accessibilityRole="button" accessibilityLabel="停止" hitSlop={4} onPress={() => { tap(); onStop() }} style={styles.send}>
                <Square size={12} color={colors.onAccent} fill={colors.onAccent} strokeWidth={2.4} />
              </Pressable>
            ) : (
              <Pressable accessibilityRole="button" accessibilityLabel="发送" hitSlop={4} accessibilityState={{ disabled: sendBlocked, busy: sending }} aria-disabled={Platform.OS === 'web' ? sendBlocked : undefined} aria-busy={Platform.OS === 'web' ? sending : undefined} onPress={() => void send()} disabled={sendBlocked}
                style={[styles.send, sendBlocked && { backgroundColor: colors.tertiary }]}>
                <ArrowUp size={17} color={colors.onAccent} strokeWidth={2.4} />
              </Pressable>
            )}
          </View>
        </Field>
        {card.anchor ? <ChatAttachmentCard anchor={card.anchor} progress={card.progress} images={canAddImages} onPick={source => void pick(source)}
          onPasteImage={pasteImage ? image => void pasteImage(image) : undefined} onClosed={() => card.setAnchor(null)} /> : null}
      </View>
    </KeyboardStickyView>
  )
}


/** The composer's fade over the end of the list, in the page's colour for the scheme (a CSS gradient takes no system colour). */
function fade(scheme: 'light' | 'dark') {
  const page = plainColor('page', scheme)
  return { paddingTop: 28, backgroundImage: `linear-gradient(to bottom, ${page}00 0%, ${page}D9 45%, ${page}F7 100%)` }
}


const styles = StyleSheet.create({
  composerWrap: { paddingHorizontal: 16, paddingTop: 10, gap: 8 },
  // What scrolls under the composer fades out, as under the iOS bar at the top.
  overlay: { position: 'absolute', left: 0, right: 0, bottom: 0 },
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
  // 36 points, as the Claude and ChatGPT apps' send button; its hitSlop keeps the 44-point target.
  send: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.accentFill, alignItems: 'center', justifyContent: 'center', margin: 4 },
})
