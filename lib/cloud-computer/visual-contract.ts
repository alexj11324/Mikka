import { z } from 'zod'
import { createHash } from 'node:crypto'

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
const scopedDecisions = z.record(z.string(), z.enum(['allow','ask','deny']))
/** Bots operate their browsers without asking by default (Alex, 2026-10-30,
 * as ChatGPT agent and Claude for Chrome act until the person takes over): the
 * gate before an action is the Decisions judgment that it serves the person's
 * task. What the person or an admin set explicitly is followed: a workspace
 * computer deny or an explicit deny blocks it, and an explicit ask for this
 * effect waits for their approval card (2026-11-01: a setting the person chose
 * is never read as allow). */
export function browserPermission(effect: BrowserEffect, computer: 'allow'|'deny', agent: unknown, workspace: unknown): 'allow'|'ask'|'deny' {
  const action = `browser_${effect}`
  const layers = [scopedDecisions.parse(agent), scopedDecisions.parse(workspace)]
  if (computer === 'deny' || layers.some(layer => layer[action] === 'deny')) return 'deny'
  return layers.some(layer => layer[action] === 'ask') ? 'ask' : 'allow'
}
