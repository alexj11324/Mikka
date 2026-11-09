import { expect, it } from 'vitest'
import { toolDuration } from './tool-duration'

it('measures overlapping calls independently before batches are persisted', () => {
  let now = 0
  const observe = toolDuration(() => now)
  observe({ type: 'tool-input-available', toolCallId: 'a', toolName: 'bash', input: {} })
  now = 20
  observe({ type: 'tool-input-available', toolCallId: 'b', toolName: 'Read', input: {} })
  now = 30
  observe({ type: 'tool-input-available', toolCallId: 'a', toolName: 'bash', input: {} })
  now = 120
  expect(observe({ type: 'tool-output-available', toolCallId: 'a', output: 'ok' }).toolDurationMs).toBe(120)
  now = 150
  expect(observe({ type: 'tool-output-error', toolCallId: 'b', errorText: 'failed' }).toolDurationMs).toBe(130)
  expect(observe({ type: 'tool-output-available', toolCallId: 'a', output: 'duplicate', toolDurationMs: 5 })).not.toHaveProperty('toolDurationMs')
})

it('does not fabricate durations for missing starts or a resumed session', () => {
  const observe = toolDuration(() => 0)
  observe({ type: 'tool-input-available', toolCallId: 'old', toolName: 'bash', input: {} })
  const resumed = toolDuration(() => 50)
  expect(resumed({ type: 'tool-output-available', toolCallId: 'old', output: '', toolDurationMs: 123 })).not.toHaveProperty('toolDurationMs')
  expect(observe({ type: 'tool-output-available', toolCallId: 'missing', output: '' })).not.toHaveProperty('toolDurationMs')
  expect(observe({ type: 'tool-output-available', toolCallId: 'old', output: '' }).toolDurationMs).toBe(0)
})
