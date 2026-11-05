import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ROOT_CONTEXT, defaultTextMapGetter } from '@opentelemetry/api'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { InMemorySpanExporter, SamplingDecision, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base'
import { deviceRegistered } from '../../packages/protocol/src/device'
import { daemonTraceSettings } from './config'
import { createTracerProvider } from './node'

const production = { VERCEL: '1', VERCEL_ENV: 'production', NODE_ENV: 'production' }

test('device registration hands the daemon only a public token and the PostHog endpoint', () => {
  const settings = daemonTraceSettings(production, 'phc_projecttoken1')
  assert.deepEqual(settings, { endpoint: 'https://us.i.posthog.com/i/v1/traces', projectToken: 'phc_projecttoken1', sampleRate: 0.1, environment: 'production' })
  assert.deepEqual(deviceRegistered.parse({ deviceId: 'device-1', workspaceId: '6f1c1f1e-3a5b-4c8d-9e0f-1a2b3c4d5e6f', tracing: settings }).tracing, settings)
  // A personal key, an unknown collector, an embedded credential or tracing turned off sends nothing.
  assert.equal(daemonTraceSettings(production, 'phx_personalkey1'), undefined)
  assert.equal(daemonTraceSettings({ ...production, MIKKA_TRACE_ENDPOINT: 'https://collector.example.com/i/v1/traces' }, 'phc_projecttoken1'), undefined)
  assert.equal(daemonTraceSettings({ ...production, MIKKA_TRACE_ENDPOINT: 'https://user:pass@us.i.posthog.com/i/v1/traces' }, 'phc_projecttoken1'), undefined)
  assert.equal(daemonTraceSettings({ ...production, MIKKA_TRACE_ENDPOINT: 'http://127.0.0.1:4318/v1/traces' }, 'phc_projecttoken1'), undefined)
  assert.equal(daemonTraceSettings({ ...production, MIKKA_TRACE_SAMPLE_RATE: '0' }, 'phc_projecttoken1'), undefined)
  assert.equal(daemonTraceSettings({ NODE_ENV: 'test' }, 'phc_projecttoken1'), undefined)
  // A malformed block never fails an otherwise valid registration.
  assert.equal(deviceRegistered.parse({ deviceId: 'device-1', workspaceId: '6f1c1f1e-3a5b-4c8d-9e0f-1a2b3c4d5e6f', tracing: { projectToken: 'secret' } }).tracing, undefined)
})

test('at equal rates the server keeps exactly the daemon traces the daemon kept', () => {
  const provider = createTracerProvider({ exporter: new InMemorySpanExporter(), sampleRate: 0.1, environment: 'dev' })
  const daemonSampler = new TraceIdRatioBasedSampler(0.1)
  const tracer = provider.getTracer('join')
  const w3c = new W3CTraceContextPropagator()
  let kept = 0
  for (let i = 0; i < 400; i++) {
    const traceId = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('')
    const daemonKept = daemonSampler.shouldSample(ROOT_CONTEXT, traceId).decision === SamplingDecision.RECORD_AND_SAMPLED
    const headers = { traceparent: `00-${traceId}-1234567890abcdef-${daemonKept ? '01' : '00'}` }
    const parent = w3c.extract(ROOT_CONTEXT, headers, defaultTextMapGetter)
    const span = tracer.startSpan('POST /v1/devices/[deviceId]/heartbeat', {}, parent)
    assert.equal(span.isRecording(), daemonKept)
    assert.equal(span.spanContext().traceId, traceId)
    if (daemonKept) kept++
    span.end()
  }
  assert.ok(kept > 10 && kept < 90)
})
