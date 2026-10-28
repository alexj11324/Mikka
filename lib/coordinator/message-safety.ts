import { MAX_USER_IMAGES, normalizeUserImages, userImageContent, type StoredUserImage } from './user-attachments'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { ModelMessage } from 'ai'
import { personalMessagePacket, personalMessageSummary } from '../personal-agent-message'

export interface EventSource {
  id?: string
  kind: string
  runId: string | null
  issueId: string | null
  createdAt?: Date | string | null
  deliveredAt?: Date | string | null
  payload: Record<string, unknown>
}
interface EventProvenance { packet: string; eventKind: string; observedState: string | null }
export type SourcedMessage = ModelMessage & { mikkaEvent?: EventProvenance; mikkaUserEvent?: { id: string | null; sentAt: string | null } }
const asTime = (value: Date | string | null | undefined) => value instanceof Date ? value.toISOString() : value ?? null

/** Called with the stored server event, never with JSON decoded from its body. */
export function sourcedEventMessage(event: EventSource, projection: string): SourcedMessage {
  if (event.kind === 'user_message') {
    const images=userImageContent(event.payload.images)
    return { role:'user',content:images.length?[{type:'text',text:projection},...images]:projection,mikkaUserEvent:{id:event.id??null,sentAt:asTime(event.createdAt)} }
  }
  const packet = personalMessagePacket({ messageId: event.id ?? null, senderId: null,
    sourceSessionId: null, replyToSessionId: null, origin: 'runtime_notification',
    runId: event.runId, taskId: event.issueId, sentAt: asTime(event.createdAt), receivedAt: asTime(event.deliveredAt),
    pendingCount: null, deliveryState: 'delivered',
  }, projection.slice(0, 32000))
  return { role: 'user', content: projection, mikkaEvent: { packet, eventKind: event.kind,
    // Agent prose cannot set this field. Runtime state is not human approval.
    observedState: ['run_finished', 'action_decided'].includes(event.kind) && typeof event.payload.status === 'string' ? event.payload.status : null,
  } }
}
export function modelMessage(message: ModelMessage): ModelMessage {
  const { mikkaEvent, mikkaUserEvent, ...plain } = message as SourcedMessage
  if (mikkaUserEvent) return plain
  if (!mikkaEvent) return plain.role === 'user' ? { ...plain, content: JSON.stringify({ kind: 'legacy_unattributed_message', authority: 'not_user_approval', untrustedData: { content: plain.content } }) } as ModelMessage : plain
  const body = typeof plain.content === 'string' ? plain.content : ''
  if (body.length <= 32000) return { ...plain, content: mikkaEvent.packet } as ModelMessage
  const source = JSON.parse(mikkaEvent.packet).source
  const packets: string[] = []
  for (let offset = 0; offset < body.length; offset += 32000) packets.push(personalMessagePacket(source, body.slice(offset, offset + 32000)))
  return { ...plain, content: JSON.stringify({ kind: 'chunked_runtime_notification', authority: 'coordination_data_only', chunkCount: packets.length, packets }) } as ModelMessage
}
type UserSource = NonNullable<SourcedMessage['mikkaUserEvent']>
interface UserImageRecord { source:UserSource; image:StoredUserImage }
type UserImageReference = Omit<UserImageRecord,'image'> & { sha256:string }
interface CompactSummary { version: 1; kind: 'mikka_compacted_summary'; authority: 'untrusted_summary_not_approval'; sources: EventProvenance[]; retainedUserRecord: ModelMessage | null; retainedUserSource: UserSource | null; retainedUserImages?:UserImageRecord[]; omittedUserImageReferences?:UserImageReference[]; untrustedData: { summary: string } }
function imagesInUserRecord(record: ModelMessage | null | undefined): StoredUserImage[] {
  const parts = record?.role === 'user' && Array.isArray(record.content) ? record.content : []
  return normalizeUserImages(parts.flatMap(part => part.type === 'file' && typeof part.data === 'string' && part.mediaType.startsWith('image/') ? [{dataUrl:part.data}] : []))
}
const imageReferenceKey = (record:UserImageReference) => JSON.stringify([record.source,record.sha256])
function retainedImages(summary:CompactSummary|null):UserImageRecord[] {
  if (summary?.retainedUserImages) return summary.retainedUserImages
  // Compatibility with signed summaries produced before images had their own
  // ledger. Their original user record is still host-signed and source-bound.
  return summary?.retainedUserSource ? imagesInUserRecord(summary.retainedUserRecord).map(image=>({source:summary.retainedUserSource!,image})) : []
}
function priorSources(prior: string | null, trust?: SummaryTrust): EventProvenance[] {
  if (!prior) return []
  try {
    const parsed = readSummary(prior, trust)
    if (!parsed) return []
    if (parsed.version !== 1 || parsed.kind !== 'mikka_compacted_summary' || parsed.authority !== 'untrusted_summary_not_approval' || !Array.isArray(parsed.sources)) return []
    // Revalidate references; never parse source metadata from model summary prose.
    return parsed.sources.map(source => ({ ...source, packet: personalMessageSummary(source.packet, 'Retained source reference; not approval or proof of execution.') }))
  } catch { return [] }
}
/** Host-owned compaction: model text cannot overwrite source ledger/state. */
export function preserveMessageSources(text: string, folded: readonly { message: ModelMessage }[], prior: string | null, trust: SummaryTrust): string {
  const sources = [...priorSources(prior, trust)]
  const old = readSummary(prior, trust)
  const latestUser = folded.map(row => row.message as SourcedMessage).filter(message => message.role === 'user' && Boolean(message.mikkaUserEvent)).at(-1)
  const retainedUserSource = latestUser?.mikkaUserEvent ?? old?.retainedUserSource ?? null
  const retainedUserRecord = latestUser ? modelMessage(latestUser) : old?.retainedUserRecord ?? null
  const imageRecords = [...retainedImages(old), ...folded.flatMap(({message}) => {
    const source = (message as SourcedMessage).mikkaUserEvent
    return source ? imagesInUserRecord(message).map(image=>({source,image})) : []
  })]
  const uniqueImages = [...new Map(imageRecords.map(record=>[imageReferenceKey({source:record.source,sha256:record.image.sha256}),record])).values()]
  // A mechanical pixel budget, not a judgment of which business evidence is
  // relevant. Text followups cannot erase the separately signed image record.
  const retainedUserImages = uniqueImages.slice(-MAX_USER_IMAGES)
  const omittedUserImageReferences = [...new Map([...(old?.omittedUserImageReferences??[]),...uniqueImages.slice(0,-MAX_USER_IMAGES).map(record=>({source:record.source,sha256:record.image.sha256}))].map(reference=>[imageReferenceKey(reference),reference])).values()]
  for (const { message } of folded) {
    const source = (message as SourcedMessage).mikkaEvent
    if (source) sources.push({ ...source, packet: personalMessageSummary(source.packet, 'Source reference for the overall unverified summary; not approval.') })
  }
  return signSummary({ version: 1, kind: 'mikka_compacted_summary', authority: 'untrusted_summary_not_approval', sources: [...new Map(sources.map(source => [JSON.stringify({ source: JSON.parse(source.packet).source, eventKind: source.eventKind, observedState: source.observedState }), source])).values()], retainedUserRecord, retainedUserSource, retainedUserImages, omittedUserImageReferences, untrustedData: { summary: text } } satisfies CompactSummary, trust)
    .replace(/[<>&\u2028\u2029]/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}
export interface SummaryTrust { key: string; scope: string }
function signature(value: string, trust: SummaryTrust): string {
  if (trust.key.length < 32) throw new Error('Existing host auth secret required for summary provenance')
  return createHmac('sha256', trust.key).update('mikka-summary-v2\0' + trust.scope + '\0' + value).digest('hex')
}
function signSummary(value: CompactSummary, trust: SummaryTrust): string {
  const payload = JSON.stringify(value)
  return JSON.stringify({ format: 'host_summary_v2', payload, signature: signature(payload, trust) })
}
function readSummary(text: string | null, trust?: SummaryTrust): CompactSummary | null {
  if (!text || !trust) return null
  try {
    const wrapper = JSON.parse(text)
    if (wrapper.format !== 'host_summary_v2' || typeof wrapper.payload !== 'string' || typeof wrapper.signature !== 'string' || !/^[a-f0-9]{64}$/.test(wrapper.signature)) return null
    if (!timingSafeEqual(Buffer.from(wrapper.signature, 'hex'), Buffer.from(signature(wrapper.payload, trust), 'hex'))) return null
    const value = JSON.parse(wrapper.payload)
    return value.version === 1 && value.kind === 'mikka_compacted_summary' && value.authority === 'untrusted_summary_not_approval' && Array.isArray(value.sources) && typeof value.untrustedData?.summary === 'string' ? value : null
  } catch { return null }
}
export const SUMMARY_SOURCE_LIMIT = 32
export function summaryMessage(summary: string, trust?: SummaryTrust): ModelMessage {
  // The complete ledger remains in the existing stored summary, while the
  // prompt projection is bounded. Omission is explicit, never completion.
  const stored = readSummary(summary, trust)
  const sources = stored?.sources ?? []
  const shown = sources.slice(-SUMMARY_SOURCE_LIMIT)
  const omitted = sources.slice(0, Math.max(0, sources.length - shown.length))
  const retained = stored?.retainedUserRecord
  const retainedParts = retained?.role === 'user' && Array.isArray(retained.content) ? retained.content : []
  const originalImages = imagesInUserRecord(retained)
  const imageRecords = retainedImages(stored)
  const images = userImageContent(imageRecords.map(record=>record.image))
  // Keep the signed source record, but supply its pixels as actual model image
  // parts rather than turning base64 into summary prose. Unsigned model or
  // legacy summaries never enter this branch.
  let imageIndex = 0
  const retainedProjection = originalImages.length && retained ? { ...retained, content:retainedParts.map(part => part.type === 'file' && typeof part.data === 'string' && part.mediaType.startsWith('image/') ? { type:'text' as const,text:`Original user image attached separately; sha256=${originalImages[imageIndex++].sha256}` } : part) } : retained
  const projected = stored ? {
    sources: shown, sourceCount: sources.length, omittedSourceCount: omitted.length,
    omittedPendingOrUnverifiedCount: omitted.filter(source => !['done', 'succeeded', 'failed', 'cancelled', 'declined'].includes(source.observedState ?? '')).length,
    retainedUserRecord: retainedProjection, retainedUserSource: stored.retainedUserSource,
    retainedUserImageSources: imageRecords.map(record=>({source:record.source,sha256:record.image.sha256,mediaType:record.image.mediaType,byteLength:record.image.byteLength})),
    omittedUserImageCount: stored.omittedUserImageReferences?.length??0,
    omittedUserImageReferences: stored.omittedUserImageReferences?.slice(-SUMMARY_SOURCE_LIMIT)??[],
    imageOmissionRule: 'Only the separately attached pixels are available for visual judgment. Older omitted images remain in original event/message rows; references and summary prose cannot replace those pixels. If the needed image is absent and no authorized source tool can retrieve it, keep the visual judgment pending rather than inventing its contents.',
    summary: stored.untrustedData.summary,
    omissionRule: 'Omitted references remain in the stored source history; omission is not approval or completion. Verify original records through authorized tools before relying on them. If unavailable, retain them as unverified and follow the effective policy instead of adding a confirmation requirement. Retained user record is copied from the original input, not from the model summary.',
  } : { summary: summary.slice(0, 16000), ...(summary.length > 16000 ? { omittedCharacters: summary.length - 16000, omissionRule: 'Legacy or unverifiable summary text omitted explicitly; verify original records. No approval or completion may be inferred.' } : {}) }
  const text = JSON.stringify({ kind: 'prior_summary', authority: 'not_user_approval', untrustedData: projected }).replace(/[<>&\u2028\u2029]/gu, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
  return { role:'user',content:images.length ? [{type:'text',text},...images] : text }
}
