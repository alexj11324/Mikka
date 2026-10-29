import { z } from 'zod'
import { createHash } from 'node:crypto'
import { resolveScopedWritePermission } from '@/lib/operations/write-policy'

const coordinate = z.number().int().min(0).max(8191)
const point = { x: coordinate, y: coordinate }
export const browserMutationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('navigate'), url: z.string().url().max(4096) }).strict(),
  z.object({ action: z.literal('click'), ...point }).strict(),
  z.object({ action: z.literal('type'), text: z.string().min(1).max(2000) }).strict(),
  z.object({ action: z.literal('key'), key: z.enum(['Enter','Tab','Escape','ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Backspace','Delete','Home','End','PageDown','PageUp']) }).strict(),
  z.object({ action: z.literal('scroll'), ...point, deltaX: z.number().int().min(-2000).max(2000), deltaY: z.number().int().min(-2000).max(2000) }).strict(),
  z.object({ action: z.literal('drag'), ...point, toX: coordinate, toY: coordinate }).strict(),
])
export type BrowserMutation = z.infer<typeof browserMutationSchema>
export const browserStepSchema = z.object({
  action: z.enum(['navigate','observe','click','type','key','scroll','drag','done','waiting']),
  url: z.string().max(4096).optional(), x: coordinate.optional(), y: coordinate.optional(),
  toX: coordinate.optional(), toY: coordinate.optional(),
  deltaX: z.number().int().min(-2000).max(2000).optional(), deltaY: z.number().int().min(-2000).max(2000).optional(),
  text: z.string().max(2000).optional(), key: z.string().max(30).optional(),
  step: z.string().min(1).max(300), summary: z.string().max(1000),
}).strict()
export type BrowserStep = z.infer<typeof browserStepSchema>
export function mutationFromStep(step: BrowserStep): BrowserMutation {
  const { step: _step, summary: _summary, ...mutation } = step
  return browserMutationSchema.parse(Object.fromEntries(Object.entries(mutation).filter(([,value]) => value !== undefined)))
}
export const browserEffects = ['browse','edit_draft','write_external','payment','sensitive_delete','security_change'] as const
export type BrowserEffect = typeof browserEffects[number]
export const visualObservationSchema = z.object({
  observationId: z.string().regex(/^[a-f0-9]{32}$/), loaderId: z.string().min(1).max(200),
  origin: z.string().max(4096), observedAt: z.number().int().positive(),
  screenshot: z.string().min(32).max(5_600_000).regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/),
  width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192),
  observation: z.object({ url: z.string().max(4096), title: z.string().max(1000), text: z.string().max(16000), needsLogin: z.boolean(), elements: z.array(z.unknown()).max(150) }),
}).strict()
export type VisualObservation = z.infer<typeof visualObservationSchema>
export function observationMetadata(observation: VisualObservation) {
  const { screenshot, ...metadata } = observation
  return { ...metadata, imageDigest: createHash('sha256').update(Buffer.from(screenshot.slice(screenshot.indexOf(',')+1),'base64')).digest('hex') }
}
export function browserPermission(effect: BrowserEffect, computer: 'allow'|'ask'|'deny', agent: unknown, workspace: unknown): 'allow'|'ask'|'deny' {
  if (computer === 'deny') return 'deny'
  // Reading/navigating/drafting within an already authorized web task does not
  // require a second per-click approval. External effects use their registered
  // action policy; a bare computer allow is not a payment or sharing grant.
  const action = `browser_${effect}`
  const safe = effect === 'browse' || effect === 'edit_draft'
  const fallback = safe ? { [action]:'allow' } : {}
  const parsed = z.record(z.string(),z.enum(['allow','ask','deny'])).parse(agent)
  return resolveScopedWritePermission(action, {...fallback,...parsed},workspace)
}
