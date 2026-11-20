import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  PROFILE_GLYPHS,
  PROFILE_MARK_STATES,
  profileMarkStateOf,
  profileMarkStateRequiresText,
} from '@/lib/factory/agent-profile-mark'
import {
  PROFILE_MARK_MAX_DIAG,
  PROFILE_MARK_STATE_TEXT_CLASS,
  PROFILE_MARK_SWEEP_DURATION_MS,
  ProfileMark,
  profileMarkDotDelayMs,
} from './profile-mark'

test('profileMarkStateOf maps canonical Figma statuses, ThreadGroups and raw run statuses', () => {
  // Canonical Figma section 21 statuses
  assert.equal(profileMarkStateOf({ status: 'working' }), 'working')
  assert.equal(profileMarkStateOf({ status: 'waiting-on-you' }), 'needs-you')
  assert.equal(profileMarkStateOf({ status: 'failed' }), 'failed')
  assert.equal(profileMarkStateOf({ status: 'idle' }), 'idle')

  // Existing Mikka ThreadGroups
  assert.equal(profileMarkStateOf({ group: 'running' }), 'working')
  assert.equal(profileMarkStateOf({ group: 'waiting' }), 'needs-you')
  assert.equal(profileMarkStateOf({ group: 'blocked' }), 'failed')
  assert.equal(profileMarkStateOf({ group: 'idle' }), 'idle')
  assert.equal(profileMarkStateOf({ group: 'resolved' }), 'idle')

  // Raw run statuses & waiting flag & outcome
  for (const active of ['queued', 'preparing', 'running', 'finishing']) {
    assert.equal(profileMarkStateOf({ status: active }), 'working', active)
  }
  assert.equal(profileMarkStateOf({ status: 'waiting_input' }), 'needs-you')
  assert.equal(profileMarkStateOf({ status: 'stopped', waiting: true }), 'needs-you')
  assert.equal(profileMarkStateOf({ status: 'stopped', outcome: 'needs_input' }), 'needs-you')
  assert.equal(profileMarkStateOf({ status: 'stopped', outcome: 'failed' }), 'failed')
  assert.equal(profileMarkStateOf({ status: 'stopped', outcome: 'blocked' }), 'failed')
  assert.equal(profileMarkStateOf({ status: 'paused' }), 'failed')
  assert.equal(profileMarkStateOf({ status: 'stopped', outcome: 'done' }), 'idle')
  assert.equal(profileMarkStateOf({}), 'idle')
})

test('profileMarkStateRequiresText enforces adjacent text on needs-you and failed only', () => {
  assert.equal(profileMarkStateRequiresText('working'), false)
  assert.equal(profileMarkStateRequiresText('idle'), false)
  assert.equal(profileMarkStateRequiresText('needs-you'), true)
  assert.equal(profileMarkStateRequiresText('failed'), true)
  assert.equal(PROFILE_MARK_STATE_TEXT_CLASS['needs-you'], 'text-warning')
  assert.equal(PROFILE_MARK_STATE_TEXT_CLASS.failed, 'text-destructive')
})

test('ProfileMark keeps glyph dots identical across all four states and applies state/profile tokens', () => {
  const renderMark = (props: Parameters<typeof ProfileMark>[0]) => renderToStaticMarkup(<ProfileMark {...props} />)

  for (const icon of PROFILE_GLYPHS) {
    const counts = PROFILE_MARK_STATES.map(state => {
      const html = renderMark({ icon, color: 'blue', state })
      assert.match(html, new RegExp(`data-profile-mark-state="${state}"`))
      assert.match(html, new RegExp(`data-profile-mark-icon="${icon}"`))
      return (html.match(/<circle /g) ?? []).length
    })
    assert.ok(counts[0] > 0, `${icon} has dots`)
    assert.equal(new Set(counts).size, 1, `${icon} dot count does not change with state`)
  }

  // working & idle use Profile's own chromatic token
  assert.match(renderMark({ icon: 'square', color: 'blue', state: 'working' }), /text-avatar-1/)
  assert.match(renderMark({ icon: 'square', color: 'blue', state: 'idle' }), /text-avatar-1/)
  assert.match(renderMark({ icon: 'lines', color: 'teal', state: 'working' }), /text-chart-2/)
  assert.match(renderMark({ icon: 'check', color: 'emerald', state: 'idle' }), /text-avatar-3/)
  assert.match(renderMark({ icon: 'arrow', color: 'violet', state: 'working' }), /text-avatar-4/)
  assert.match(renderMark({ icon: 'diamond', color: 'pink', state: 'idle' }), /text-avatar-2/)

  // needs-you & failed override colour with semantic tokens
  assert.match(renderMark({ icon: 'diamond', color: 'pink', state: 'needs-you' }), /text-warning/)
  assert.doesNotMatch(renderMark({ icon: 'diamond', color: 'pink', state: 'needs-you' }), /text-avatar-2/)
  assert.match(renderMark({ icon: 'arrow', color: 'violet', state: 'failed' }), /text-destructive/)
  assert.doesNotMatch(renderMark({ icon: 'arrow', color: 'violet', state: 'failed' }), /text-avatar-4/)

  // Accessibility: decorative without label, named img with label
  assert.match(renderMark({ icon: 'square', color: 'blue' }), /aria-hidden="true"/)
  const named = renderMark({ icon: 'square', color: 'blue', state: 'needs-you', label: 'Needs you' })
  assert.match(named, /role="img"/)
  assert.match(named, /aria-label="Needs you"/)
})

test('profileMarkDotDelayMs sweeps forward from top-left to bottom-right over 1200ms', () => {
  // In WAAPI, activeTime = localTime - delay, so lagging higher diagonals sweeps diag 0 -> 1 -> ... -> 8
  assert.equal(profileMarkDotDelayMs(0, 0), 0)
  assert.equal(profileMarkDotDelayMs(4, 4), 0)
  assert.equal(profileMarkDotDelayMs(2, 2), -PROFILE_MARK_SWEEP_DURATION_MS / 2)
  assert.ok(profileMarkDotDelayMs(1, 0) < profileMarkDotDelayMs(1, 1))
  assert.equal(profileMarkDotDelayMs(1, 0), -Math.round(((PROFILE_MARK_MAX_DIAG - 1) / PROFILE_MARK_MAX_DIAG) * PROFILE_MARK_SWEEP_DURATION_MS))
})
