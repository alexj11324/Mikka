import { ROOT_CONTEXT, SpanStatusCode, trace, type Attributes } from '@opentelemetry/api'
import { SeverityNumber, type Logger } from '@opentelemetry/api-logs'
import { ExportResultCode, type ExportResult } from '@opentelemetry/core'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto'
import type { Resource } from '@opentelemetry/resources'
import { BatchLogRecordProcessor, LoggerProvider, type LogRecordExporter, type ReadableLogRecord } from '@opentelemetry/sdk-logs'
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base'

type Sanitizer = (attributes: Attributes) => Attributes

/** No console/pino bridge: only completed stage metadata enters the log exporter. */
export class SafeLogExporter implements LogRecordExporter {
  private pausedUntil = 0
  constructor(private readonly inner: LogRecordExporter, private readonly sanitize: Sanitizer, private readonly now: () => number = Date.now) {}
  export(records: ReadableLogRecord[], done: (result: ExportResult) => void): void {
    if (this.now() < this.pausedUntil) return done({ code: ExportResultCode.SUCCESS })
    try {
      this.inner.export(records.map(record => Object.create(record, {
        body: { value: record.severityNumber === SeverityNumber.ERROR ? 'mikka.stage.failed' : 'mikka.stage.completed', enumerable: true },
        attributes: { value: this.sanitize(record.attributes as Attributes), enumerable: true },
      }) as ReadableLogRecord), result => {
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

export function createLogProvider(options: { endpoint: string; projectToken: string; resource: Resource; sanitize: Sanitizer; exporter?: LogRecordExporter }): LoggerProvider {
  const exporter = options.exporter ?? new OTLPLogExporter({ url: options.endpoint.replace(/\/traces$/, '/logs'), headers: { Authorization: `Bearer ${options.projectToken}` }, timeoutMillis: 5_000 })
  return new LoggerProvider({
    resource: options.resource,
    processors: [new BatchLogRecordProcessor({ exporter: new SafeLogExporter(exporter, options.sanitize), maxQueueSize: 512, maxExportBatchSize: 256, scheduledDelayMillis: 5_000, exportTimeoutMillis: 10_000 })],
    logRecordLimits: { attributeCountLimit: 64, attributeValueLengthLimit: 256 },
  })
}

/** Logs have the exact span context, including when the SDK callback ran outside an active scope. */
export class StageLogProcessor implements SpanProcessor {
  constructor(private readonly logger: Logger, private readonly sanitize: Sanitizer) {}
  onStart(): void {}
  onEnd(span: ReadableSpan): void {
    const failed = span.status.code === SpanStatusCode.ERROR
    if (!failed && !/^daemon\.(?:run(?:\.|$)|adapter\.|registration|bootstrap\.|gateway\.|ai\.)/.test(span.name)) return
    try {
      const [seconds, nanos] = span.duration
      this.logger.emit({
        context: trace.setSpanContext(ROOT_CONTEXT, span.spanContext()), timestamp: span.endTime,
        severityNumber: failed ? SeverityNumber.ERROR : SeverityNumber.INFO,
        severityText: failed ? 'ERROR' : 'INFO',
        body: failed ? 'mikka.stage.failed' : 'mikka.stage.completed',
        attributes: this.sanitize({ ...span.attributes, 'mikka.stage': span.name,
          'mikka.duration_ms': seconds * 1_000 + nanos / 1e6, 'mikka.status': failed ? 'error' : 'ok' }),
      })
    } catch { /* Logs never alter the completed operation. */ }
  }
  forceFlush(): Promise<void> { return Promise.resolve() }
  shutdown(): Promise<void> { return Promise.resolve() }
}
