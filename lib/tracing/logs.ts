import { ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api'
import { SeverityNumber, type Logger } from '@opentelemetry/api-logs'
import { ExportResultCode, type ExportResult } from '@opentelemetry/core'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchLogRecordProcessor, LoggerProvider, type LogRecordExporter, type ReadableLogRecord } from '@opentelemetry/sdk-logs'
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { SERVICE_NAME, type TraceEnvironment } from './config'
import { sanitizeAttributes, sanitizeSpanName } from './sanitize'

/** Only fixed stage names and allowlisted span metadata enter PostHog Logs. */
export class SafeLogExporter implements LogRecordExporter {
  private pausedUntil = 0
  constructor(private readonly inner: LogRecordExporter, private readonly now: () => number = Date.now) {}
  export(records: ReadableLogRecord[], done: (result: ExportResult) => void): void {
    if (this.now() < this.pausedUntil) return done({ code: ExportResultCode.SUCCESS })
    try {
      const clean = records.map(record => Object.create(record, {
        body: { value: record.severityNumber === SeverityNumber.ERROR ? 'mikka.stage.failed' : 'mikka.stage.completed', enumerable: true },
        attributes: { value: sanitizeAttributes(record.attributes as Parameters<typeof sanitizeAttributes>[0]), enumerable: true },
      }) as ReadableLogRecord)
      this.inner.export(clean, result => {
        if (result.code !== ExportResultCode.SUCCESS) this.pausedUntil = this.now() + 60_000
        done({ code: ExportResultCode.SUCCESS })
      })
    } catch {
      this.pausedUntil = this.now() + 60_000
      done({ code: ExportResultCode.SUCCESS })
    }
  }
  shutdown(): Promise<void> { return this.inner.shutdown().catch(() => {}) }
  forceFlush(): Promise<void> { return this.inner.forceFlush().catch(() => {}) }
}

export function createLogProvider(options: { endpoint: string; token: string; environment: TraceEnvironment; version?: string; exporter?: LogRecordExporter }): LoggerProvider {
  const exporter = options.exporter ?? new OTLPLogExporter({ url: options.endpoint.replace(/\/traces$/, '/logs'), headers: { Authorization: `Bearer ${options.token}` }, timeoutMillis: 5_000 })
  return new LoggerProvider({
    resource: resourceFromAttributes({ 'service.name': SERVICE_NAME, 'deployment.environment.name': options.environment, ...(options.version ? { 'service.version': options.version } : {}) }),
    processors: [new BatchLogRecordProcessor({ exporter: new SafeLogExporter(exporter), maxQueueSize: 2048, maxExportBatchSize: 512, scheduledDelayMillis: 5_000, exportTimeoutMillis: 10_000 })],
    logRecordLimits: { attributeCountLimit: 64, attributeValueLengthLimit: 256 },
  })
}

/** Workflow and dispatch stages plus errors; SQL/query success spans stay APM-only. */
export class StageLogProcessor implements SpanProcessor {
  constructor(private readonly logger: Logger) {}
  onStart(): void {}
  onEnd(span: ReadableSpan): void {
    const failed = span.status.code === SpanStatusCode.ERROR
    if (!failed && !/^(?:workflow[.:]|step[.:]|dispatch[._]|cloud[._]|computer[._]|factory[._]|completion[._]|e2b[._])/.test(span.name)) return
    try {
      const [seconds, nanos] = span.duration
      this.logger.emit({
        context: trace.setSpanContext(ROOT_CONTEXT, span.spanContext()),
        timestamp: span.endTime,
        severityNumber: failed ? SeverityNumber.ERROR : SeverityNumber.INFO,
        severityText: failed ? 'ERROR' : 'INFO',
        body: failed ? 'mikka.stage.failed' : 'mikka.stage.completed',
        attributes: { ...sanitizeAttributes(span.attributes), 'mikka.stage': sanitizeSpanName(span.name), 'mikka.duration_ms': seconds * 1_000 + nanos / 1e6, 'mikka.status': failed ? 'error' : 'ok' },
      })
    } catch { /* telemetry never changes the completed operation */ }
  }
  forceFlush(): Promise<void> { return Promise.resolve() }
  shutdown(): Promise<void> { return Promise.resolve() }
}
