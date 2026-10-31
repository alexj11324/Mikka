import { createContext, Fragment, useContext, useState } from 'react'
import { Image, Linking, Pressable, StyleSheet, TextInput, View } from 'react-native'
import { ArrowUpRight, Check } from 'lucide-react-native'
import { BotBubble } from '@/components/chat'
import { CardButton, ChatCard, cardText } from '@/components/cards'
import { Markdown } from '@/components/Markdown'
import { Text } from '@/components/Text'
import { useImage, type FoundImage } from '@/lib/images'
import { arr, inlineMarkdown, isComponent, obj, openUIText, parseOpenUI, str, type Component, type Value } from '@/lib/openui'
import type { CitationSource } from '@/lib/types'
import { openOnWeb } from '@/lib/web'
import { colors, font } from '@/lib/theme'

/**
 * What a card can do in its chat. `live` is false once the person has written
 * after it (the card was answered, here or another way): its buttons stop.
 * `answer` posts the reply as the person's message and resolves true when it
 * was sent, as the web's cards continue the conversation (agent-decision.tsx).
 */
interface CardContext {
  live: boolean
  /** What the person wrote next, if anything: a choice card marks the option it names. */
  reply?: string
  answer: (text: string) => Promise<boolean>
  webPath: string
  sources: Record<string, CitationSource>
  onOpen: (source: CitationSource) => void
}

const Context = createContext<CardContext | null>(null)
const useCard = () => {
  const value = useContext(Context)
  if (!value) throw new Error('OpenUI card outside its reply')
  return value
}

/** A reply written as OpenUI cards (lib/openui-lang.ts), drawn natively. */
export function OpenUIReply({ text, ...context }: CardContext & { text: string }) {
  const root = parseOpenUI(text)
  return (
    <Context.Provider value={context}>
      <View style={styles.reply}>{root === null ? <WebOnly text={looseText(text)} /> : <Node value={root} />}</View>
    </Context.Provider>
  )
}

/** The quoted words of OpenUI that did not parse, so the reply still says something. */
function looseText(text: string) {
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(match => match[1].replace(/\\n/g, '\n').replace(/\\(.)/g, '$1'))
    .filter(part => /[^\x00-\x7f]|\s/.test(part)).join('\n')
}

function Node({ value }: { value: Value | undefined }) {
  if (Array.isArray(value)) return <>{value.map((item, index) => <Node key={index} value={item} />)}</>
  if (typeof value === 'string') return value.trim() ? <Words text={value} /> : null
  if (!isComponent(value)) return null
  switch (value.name) {
    case 'Stack': case 'BeResponse': return <View style={styles.stack}><Node value={value.props.children} /></View>
    case 'TextContent': return <Words text={str(value.props.text)} />
    case 'InlineText': return <Words text={inlineMarkdown(value.props.parts)} />
    case 'TaskChip': case 'RunChip': case 'SourceChip': return <Words text={inlineMarkdown(value)} />
    case 'BeCard': return <Card value={value} />
    case 'BeQuestions': return <Questions value={value} />
    case 'BeApproval': return <Approval value={value} />
    case 'BeFollowUps': return <FollowUps value={value} />
    case 'BeButton': return <PromptButton value={value} />
    // One column: the web's grid only goes to two from 26rem, wider than a phone's reply.
    case 'BeCardGrid': return <View style={styles.stack}><Node value={value.props.children} /></View>
    case 'BeImageCard': return <ImageCard value={value} />
    case 'BeImage': return <Figure value={value} />
    default: return <WebOnly text={openUIText(value)} />
  }
}

/** The bot's words keep the grey bubble (R-14); only cards go without. */
function Words({ text }: { text: string }) {
  const { sources, onOpen } = useCard()
  if (!text.trim()) return null
  return <BotBubble><Markdown text={text} sources={sources} onOpen={onOpen} /></BotBubble>
}

function Card({ value }: { value: Component }) {
  const { sources, onOpen } = useCard()
  const description = str(value.props.description)
  return (
    <ChatCard>
      <Text style={cardText.title}>{str(value.props.title)}</Text>
      {description ? <Text style={cardText.meta}>{description}</Text> : null}
      {arr(value.props.children).map((child, index) => {
        // Text inside a card has no bubble of its own.
        if (isComponent(child) && (child.name === 'TextContent' || child.name === 'InlineText')) {
          const text = child.name === 'TextContent' ? str(child.props.text) : inlineMarkdown(child.props.parts)
          return <Markdown key={index} text={text} sources={sources} onOpen={onOpen} />
        }
        return <Fragment key={index}><Node value={child} /></Fragment>
      })}
    </ChatCard>
  )
}

/** Sending an answer from a card: one at a time, kept on failure so it can be tapped again. */
function useAnswer() {
  const { live, answer } = useCard()
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle')
  const send = async (text: string) => {
    if (!live || state === 'sending' || state === 'sent') return
    setState('sending')
    setState(await answer(text) ? 'sent' : 'failed')
  }
  return { send, state, open: live && state !== 'sent' && state !== 'sending' }
}

const Failed = ({ state }: { state: string }) => state === 'failed' ? <Text style={cardText.error}>没发出去，再试一次。</Text> : null

interface Question { id: string; title: string; options: { value: string; label: string }[]; multiple: boolean; allowCustom: boolean }

function questionsOf(value: Component): Question[] {
  return arr(value.props.questions).map((item, index) => {
    const q = obj(item)
    return {
      id: str(q.id) || String(index),
      title: str(q.title),
      options: arr(q.options).map(option => ({ value: str(obj(option).value), label: str(obj(option).label) })).filter(option => option.label),
      multiple: q.multiple === true,
      allowCustom: q.allowCustom === true,
    }
  }).filter(question => question.title)
}

/**
 * BeQuestions. One single-answer question is the choice card (Figma 208:4780,
 * as the web's ChoiceCard): options lettered A, B, C…, a tap is the reply.
 * Several questions, or several answers, pick then send in one message with
 * the context, in the web's words (agent-decision.tsx).
 */
function Questions({ value }: { value: Component }) {
  const questions = questionsOf(value)
  const { reply } = useCard()
  const { send, state, open } = useAnswer()
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
  if (!questions.length) return null
  const [only] = questions
  if (questions.length === 1 && !only.multiple && only.options.length) {
    const choice = picked[only.id]?.[0] ?? only.options.find(option => option.label === reply?.trim())?.value
    return (
      <ChatCard>
        <Text style={cardText.title}>{only.title}</Text>
        <View style={{ gap: 4 }}>
          {only.options.map((option, index) => (
            <Pressable key={option.value || index} accessibilityRole="button" accessibilityState={{ selected: choice === option.value, disabled: !open }} disabled={!open}
              onPress={() => { setPicked({ [only.id]: [option.value] }); void send(option.label) }}
              style={({ pressed }) => [styles.option, (pressed || choice === option.value) && { backgroundColor: colors.bubble }, !open && choice !== option.value && { opacity: 0.5 }]}>
              <View style={styles.letter}><Text style={styles.letterText}>{String.fromCharCode(65 + index)}</Text></View>
              <Text style={[cardText.body, { flex: 1 }]}>{option.label}</Text>
            </Pressable>
          ))}
        </View>
        <Failed state={state} />
      </ChatCard>
    )
  }
  const toggle = (question: Question, option: string) => setPicked(current => {
    const now = current[question.id] ?? []
    const next = question.multiple ? (now.includes(option) ? now.filter(item => item !== option) : [...now, option]) : [option]
    return { ...current, [question.id]: next }
  })
  const answered = questions.every(question => (picked[question.id]?.length ?? 0) > 0 || custom[question.id]?.trim())
  const submit = () => {
    const response = questions.map(question => {
      const labels = question.options.filter(option => picked[question.id]?.includes(option.value)).map(option => option.label)
      return `${question.title}：${[...labels, custom[question.id]?.trim()].filter(Boolean).join('；')}`
    }).join('\n')
    void send(`任务背景：${str(value.props.context)}\n我的回答：\n${response}\n请根据以上信息继续提供建议，不要执行工作区操作。`)
  }
  return (
    <ChatCard>
      {questions.map(question => (
        <View key={question.id} style={{ gap: 6 }}>
          <Text style={cardText.title}>{question.title}</Text>
          {question.options.map(option => {
            const on = picked[question.id]?.includes(option.value) ?? false
            return (
              <Pressable key={option.value} accessibilityRole={question.multiple ? 'checkbox' : 'radio'} accessibilityState={{ checked: on, disabled: !open }} disabled={!open}
                onPress={() => toggle(question, option.value)} style={({ pressed }) => [styles.option, (pressed || on) && { backgroundColor: colors.bubble }]}>
                <View style={[styles.tick, question.multiple ? { borderRadius: 6 } : null, on && { backgroundColor: colors.ink }]}>
                  {on ? <Check size={14} color="#fff" strokeWidth={3} /> : null}
                </View>
                <Text style={[cardText.body, { flex: 1 }]}>{option.label}</Text>
              </Pressable>
            )
          })}
          {question.allowCustom ? (
            <TextInput value={custom[question.id] ?? ''} onChangeText={text => setCustom(current => ({ ...current, [question.id]: text }))} editable={open}
              placeholder="补充其他回答…" placeholderTextColor={colors.tertiary} style={styles.input} />
          ) : null}
        </View>
      ))}
      <View style={styles.actions}>
        <CardButton primary label={state === 'sent' ? '已提交' : '提交回答并继续'} disabled={!open || !answered} busy={state === 'sending'} onPress={submit} />
      </View>
      <Failed state={state} />
    </ChatCard>
  )
}

/** BeApproval: agree, revise or reject a proposed plan; the reply carries the plan, as the web sends it. */
function Approval({ value }: { value: Component }) {
  const { send, state, open } = useAnswer()
  const [decision, setDecision] = useState<string | null>(null)
  const title = str(value.props.title)
  const description = str(value.props.description)
  const choose = (label: string, words: string) => {
    setDecision(label)
    void send(`任务背景：${str(value.props.context)}\n待确认建议：${title}\n方案说明：${description}\n我的意见：${words}。请据此继续提供建议，不要执行工作区操作。`)
  }
  return (
    <ChatCard>
      <Text style={cardText.title}>{title}</Text>
      {description ? <Text style={cardText.body}>{description}</Text> : null}
      {state === 'sent' && decision ? <Text style={cardText.meta}>{decision}</Text> : (
        <View style={styles.actions}>
          <CardButton label="不同意" disabled={!open} onPress={() => choose('已拒绝', '不同意这个建议方案')} />
          <CardButton label="修改方案" disabled={!open} onPress={() => choose('需要修改', '请修改这个建议方案')} />
          <CardButton primary label="同意" disabled={!open} busy={state === 'sending'} onPress={() => choose('已同意', '同意这个建议方案')} />
        </View>
      )}
      <Failed state={state} />
    </ChatCard>
  )
}

/** BeFollowUps, the next steps a proactive message offers (R-20 card): each row sends its prompt. */
function FollowUps({ value }: { value: Component }) {
  const items = arr(value.props.items).map(item => ({ label: str(obj(item).label), prompt: str(obj(item).prompt) || str(obj(item).label) })).filter(item => item.label)
  const { send, state, open } = useAnswer()
  const [picked, setPicked] = useState<string | null>(null)
  if (!items.length) return null
  return (
    <View style={{ gap: 8 }}>
      {items.map(item => (
        <Pressable key={item.label} accessibilityRole="button" accessibilityState={{ disabled: !open, selected: picked === item.label }} disabled={!open}
          onPress={() => { setPicked(item.label); void send(item.prompt) }}
          style={({ pressed }) => [styles.followUp, pressed && { backgroundColor: colors.pressed }, !open && picked !== item.label && { opacity: 0.5 }]}>
          <Text style={[cardText.body, { flex: 1 }]}>{item.label}</Text>
          <ArrowUpRight size={18} color={colors.secondary} strokeWidth={2} />
        </Pressable>
      ))}
      <Failed state={state} />
    </View>
  )
}

function PromptButton({ value }: { value: Component }) {
  const { send, state, open } = useAnswer()
  const label = str(value.props.label)
  return (
    <View style={{ alignItems: 'flex-start', gap: 6 }}>
      <CardButton label={label === '填入提问' ? '直接提问' : label} disabled={!open} busy={state === 'sending'} onPress={() => void send(str(value.props.action) || label)} />
      <Failed state={state} />
    </View>
  )
}

/**
 * A picture found by its search words, 16:9 as on the web: grey while
 * looking, nothing when there is none or it fails to load.
 */
function Picture({ image, alt }: { image: FoundImage | null | undefined; alt: string }) {
  const [failed, setFailed] = useState<string | null>(null)
  if (image === undefined) return <View accessibilityLabel={alt} accessibilityState={{ busy: true }} style={styles.picture} />
  if (!image || failed === image.src) return null
  return <Image source={{ uri: image.src }} accessibilityLabel={alt} resizeMode="cover" onError={() => setFailed(image.src)} style={styles.picture} />
}

/** Where a picture is from, as the web credits it; tapping opens its Wikimedia Commons page. */
function Credit({ image }: { image: FoundImage }) {
  return (
    <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(image.source)} hitSlop={4}>
      <Text style={[cardText.meta, { textDecorationLine: 'underline' }]}>Wikimedia Commons · {image.title}{image.author ? ` · ${image.author}` : ''} · {image.license}</Text>
    </Pressable>
  )
}

/**
 * BeImageCard (web: agent-image-card.tsx): picture, title, description, tags,
 * and 继续了解 sending the card's prompt. The credit folds under 图片来源与许可.
 */
function ImageCard({ value }: { value: Component }) {
  const title = str(value.props.title)
  const description = str(value.props.description)
  const tags = arr(value.props.tags).map(str).filter(Boolean).slice(0, 3)
  const prompt = str(value.props.prompt)
  const image = useImage(str(value.props.query))
  const { send, state, open } = useAnswer()
  const [credit, setCredit] = useState(false)
  return (
    <ChatCard>
      {image === null ? null : (
        <View style={{ gap: 6 }}>
          <Picture image={image} alt={title} />
          {image ? (
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: credit }} onPress={() => setCredit(!credit)} hitSlop={4} style={{ alignSelf: 'flex-start' }}>
              <Text style={cardText.meta}>图片来源与许可</Text>
            </Pressable>
          ) : null}
          {image && credit ? <Credit image={image} /> : null}
        </View>
      )}
      <View style={{ gap: 4 }}>
        <Text style={cardText.title}>{title}</Text>
        {description ? <Text style={[cardText.body, { color: colors.secondary }]}>{description}</Text> : null}
      </View>
      {tags.length ? <View style={styles.tags}>{tags.map((tag, index) => <Text key={index} style={styles.tag}>{tag}</Text>)}</View> : null}
      {prompt ? (
        <View style={{ alignItems: 'flex-start', gap: 6 }}>
          <CardButton label={state === 'sent' ? '已提问' : '继续了解'} disabled={!open} busy={state === 'sending'} onPress={() => void send(prompt)} />
          <Failed state={state} />
        </View>
      ) : null}
    </ChatCard>
  )
}

/** BeImage (web: agent-image.tsx), a single illustration: picture, caption, credit. */
function Figure({ value }: { value: Component }) {
  const caption = str(value.props.caption)
  const image = useImage(str(value.props.query))
  if (image === null && !caption) return null
  return (
    <View style={{ gap: 6 }}>
      <Picture image={image} alt={str(value.props.alt)} />
      {caption ? <Text style={cardText.meta}>{caption}</Text> : null}
      {image ? <Credit image={image} /> : null}
    </View>
  )
}

/** A card the app cannot draw: its words, and the same chat on the web, signed in. */
function WebOnly({ text }: { text: string }) {
  const { webPath, sources, onOpen } = useCard()
  return (
    <ChatCard>
      {text.trim() ? <Markdown text={text} sources={sources} onOpen={onOpen} /> : null}
      <Pressable accessibilityRole="link" onPress={() => void openOnWeb(webPath)} style={styles.webLink} hitSlop={6}>
        <Text style={{ color: colors.accent, fontSize: 15 }}>在网页上打开</Text>
        <ArrowUpRight size={16} color={colors.accent} strokeWidth={2} />
      </Pressable>
    </ChatCard>
  )
}

const styles = StyleSheet.create({
  reply: { gap: 10, alignSelf: 'stretch' },
  stack: { gap: 10 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 8, paddingVertical: 10, borderRadius: 10 },
  letter: { width: 26, height: 26, borderRadius: 8, backgroundColor: colors.bubble, alignItems: 'center', justifyContent: 'center' },
  letterText: { fontSize: 13, color: colors.secondary, fontWeight: '600' },
  tick: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.chip, alignItems: 'center', justifyContent: 'center' },
  input: { minHeight: 44, borderRadius: 10, backgroundColor: colors.bubble, paddingHorizontal: 12, fontSize: 15, fontFamily: font, color: colors.text, outlineStyle: 'none' } as never,
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 },
  followUp: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.bubble, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12 },
  picture: { width: '100%', aspectRatio: 16 / 9, borderRadius: 10, backgroundColor: colors.bubble },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: { fontSize: 12, lineHeight: 16, color: colors.secondary, backgroundColor: colors.bubble, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, overflow: 'hidden' },
  webLink: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' },
})
