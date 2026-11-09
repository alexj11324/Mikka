import posthog from 'posthog-js'
import { posthogConfig } from '@/lib/posthog-config'
import { redactReplayRequest, sanitizeAnalyticsEvent } from '@/lib/analytics-policy'
import { watchRemovedActions } from '@/lib/app-build'
import { setLiveTelemetrySink } from '@/lib/live/telemetry'
import { acceptanceReplayOptIn, installReplayReadiness } from '@/lib/replay-readiness'

// Obsolete actions stop old traffic and offer a refresh without discarding the page.
watchRemovedActions(window)

if (posthogConfig.token) {
  const replayReadiness = installReplayReadiness(window)
  posthog.init(posthogConfig.token, {
  api_host: posthogConfig.apiHost,
  ui_host: posthogConfig.uiHost,
  defaults: '2026-05-30',
  persistence: 'memory',
  reuseAnonymousId: true,
  opt_out_useragent_filter: acceptanceReplayOptIn(window),
  person_profiles: 'identified_only',
  save_campaign_params: false,
  save_referrer: false,
  disable_capture_url_hashes: true,
  disable_conversations: true,
  autocapture: false,
  capture_pageview: false,
  capture_pageleave: false,
  capture_exceptions: false,
  capture_performance: false,
  capture_heatmaps: false,
  capture_dead_clicks: false,
  // Only this application's API hosts receive opaque person/session headers.
  tracing_headers: [window.location.hostname, 'app.aspectlylabs.com'],
  disable_session_recording: false,
  session_recording: {
    maskAllInputs: true,
    maskTextSelector: '*',
    maskAllElementAttributes: true,
    blockSelector: 'img,video,audio,canvas,iframe,object,embed,input[type="hidden"],input[type="file"],[contenteditable="true"]',
    captureJsonLd: false,
    inlineStylesheet: false,
    recordCrossOriginIframes: false,
    captureCanvas: { recordCanvas: false },
    recordHeaders: false,
    recordBody: false,
    maskCapturedNetworkRequestFn: redactReplayRequest,
    sampleRate: 1,
  },
  enable_recording_console_log: false,
  disable_surveys: true,
  disable_product_tours: true,
  disable_web_experiments: true,
  before_send: event => {
    const sanitized = sanitizeAnalyticsEvent(event)
    replayReadiness.observe(sanitized)
    return sanitized
  },
    loaded: client => {
      replayReadiness.bind(client)
      client.register({ app: 'mikka', environment: process.env.NODE_ENV, runtime: window.mikka?.app?.runtime === 'electron' ? 'electron' : 'browser' })
      setLiveTelemetrySink((event, properties) => { client.capture(event, properties) })
    },
  })
}
