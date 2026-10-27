import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { analyticsPath, sanitizeAnalyticsEvent } from '../lib/analytics-policy.ts'
import { computerAcceptancePreview, featureAvailability, gatedFeatureEnabled, gatedFeatures, upcomingFeatures } from '../lib/feature-flags.ts'

test('pageviews strip query strings, hashes, document identifiers and unapproved properties', () => {
  const event = sanitizeAnalyticsEvent({ event: '$pageview', properties: {
    $current_url: 'https://example.com/documents/01234567-89ab-cdef-0123-456789abcdef?email=private@example.com#secret',
    token: 'public-project-token', distinct_id: 'opaque-user-id', section: 'general',
    email: 'private@example.com', name: 'Private Name', $referrer: 'https://example.com/?token=secret',
    $set: { email: 'private@example.com' }, $initial_current_url: 'https://example.com/?token=secret',
    $exception_list: ['private'], description: 'private document content',
  } })
  assert.deepEqual(event.properties, {
    token: 'public-project-token', distinct_id: 'opaque-user-id', section: 'general',
    $current_url: 'https://example.com/documents/:id', $pathname: '/documents/:id',
  })
  assert.equal(analyticsPath('/settings/teams'), '/settings/teams')
  assert.equal(analyticsPath('/invite/private-invitation-token'), '/invite/:token')
})

test('automatic top-level person mutations are stripped without losing ingestion metadata', () => {
  const event = sanitizeAnalyticsEvent({
    event: '$identify', uuid: 'event-id', timestamp: '2026-10-21T00:00:00Z',
    properties: { distinct_id: 'opaque-user-id' },
    $set: { email: 'private@example.com' },
    $set_once: { $initial_current_url: 'https://example.com/?token=private' },
    $unset: ['private-property'],
  })
  assert.deepEqual(event, {
    event: '$identify', uuid: 'event-id', timestamp: '2026-10-21T00:00:00Z',
    properties: { distinct_id: 'opaque-user-id' },
  })
})

test('unknown events, replay and raw exception events never pass the allowlist', () => {
  for (const event of ['$snapshot', '$exception', '$autocapture', 'unknown']) {
    assert.equal(sanitizeAnalyticsEvent({ event, properties: {} }), null)
  }
  assert.equal(sanitizeAnalyticsEvent(null), null)
  assert.deepEqual(sanitizeAnalyticsEvent({ event: '$pageview', properties: { $current_url: 'not a url' } }).properties, {})
  assert.deepEqual(sanitizeAnalyticsEvent({ event: 'mikka_team_created', properties: { name: 'private' } }).properties, {})
})

test('all upcoming features fail closed, even if the remote switch is accidentally enabled', () => {
  for (const [feature, definition] of Object.entries(upcomingFeatures)) {
    assert.equal(definition.implemented, false)
    for (const remote of [undefined, false, true, 'control', 'true']) {
      assert.equal(featureAvailability(feature, remote).enabled, false)
      assert.equal(featureAvailability(feature, remote).key, definition.key)
    }
    assert.equal(featureAvailability(feature, true).reason, 'FeatureCopy.c_7a3f5896')
  }
})

test('gated features are on only when the remote flag is exactly true', () => {
  assert.equal(gatedFeatures.cloudComputer, 'mikka-cloud-computer')
  for (const remote of [undefined, false, 'control', 'true']) assert.equal(gatedFeatureEnabled(remote), false)
  assert.equal(gatedFeatureEnabled(true), true)
  assert.equal(computerAcceptancePreview('preview', '1'), true)
  for (const environment of [undefined, 'development', 'production']) assert.equal(computerAcceptancePreview(environment, '1'), false)
  for (const flag of [undefined, '0', 'true']) assert.equal(computerAcceptancePreview('preview', flag), false)
})

test('the locale layout mounts the pageview tracker whenever PostHog is configured', () => {
  // instrumentation-client.ts turns off automatic pageviews; without this component nothing is ever sent.
  const layout = readFileSync(new URL('../app/[locale]/layout.tsx', import.meta.url), 'utf8')
  assert.match(layout, /posthogConfig\.token && <PostHogAnalytics \/>/)
})
