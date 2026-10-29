import { describe, expect, it } from 'vitest'
import { createBotSchema, viewerGrantSchema, viewerRequestSchema, computerEventSchema } from './computer'

describe('computer wire contract', () => {
  it('rejects ownership injection when creating a Bot or requesting a viewer', () => {
    expect(createBotSchema.parse({ name: ' Bot ' })).toEqual({ name: 'Bot' })
    expect(createBotSchema.safeParse({ name: 'Bot', ownerId: 'other' }).success).toBe(false)
    expect(viewerRequestSchema.safeParse({ mode: 'control', userId: 'other' }).success).toBe(false)
  })
  it('requires an encrypted WebSocket grant with an expiration', () => {
    const expiresAt = '2026-10-26T12:00:00.000Z'
    expect(viewerGrantSchema.safeParse({ url: 'wss://desktop.example/vnc?token=fixture', expiresAt }).success).toBe(true)
    expect(viewerGrantSchema.safeParse({ url: 'ws://desktop.example/vnc', expiresAt }).success).toBe(false)
    expect(viewerGrantSchema.safeParse({ url: 'https://desktop.example/vnc', expiresAt }).success).toBe(false)
  })
  it('does not accept a desktop control push without a Bot identity', () => {
    expect(computerEventSchema.safeParse({ type: 'computer.control', control: 'user' }).success).toBe(false)
    expect(computerEventSchema.safeParse({ type: 'computer.control', botId: 'bot', control: 'user', controlledBy: { userId: 'owner' } }).success).toBe(true)
  })
})
