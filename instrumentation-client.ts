import posthog from 'posthog-js'
import { posthogConfig } from '@/lib/posthog-config'
import { sanitizeAnalyticsEvent } from '@/lib/analytics-policy'

posthog.init(posthogConfig.token, {
  api_host: posthogConfig.apiHost,
  ui_host: posthogConfig.uiHost,
  defaults: '2026-05-30',
  persistence: 'memory',
  reuseAnonymousId: true,
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
  disable_session_recording: true,
  enable_recording_console_log: false,
  disable_surveys: true,
  disable_product_tours: true,
  disable_web_experiments: true,
  before_send: sanitizeAnalyticsEvent,
  loaded: client => client.register({ app: 'orvilo', environment: process.env.NODE_ENV }),
})
