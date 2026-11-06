import { createHash } from 'node:crypto'
import { context, createContextKey, SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api'
import { safeErrorAttributes } from '@mikka/protocol/tracing'

/** Startup timings carry only a hashed run identity, fixed stage names and
 * elapsed times. No credentials, command output, paths or task text. */
export function cloudStartupRunAttributes(runId: string): Attributes {
  return { 'mikka.run.id_hash': createHash('sha256').update(runId).digest('hex').slice(0, 16) }
}

const runHashContext = createContextKey('mikka.cloud-startup.run-hash')
function timingLog(record: Record<string, unknown>) {
  try { console.info(JSON.stringify({ msg: 'cloud_startup_timing', runIdHash: context.active().getValue(runHashContext) ?? null, ...record })) }
  catch { /* Observation cannot change provisioning. */ }
}

export async function cloudStartupSpan<T>(name: string, attributes: Attributes, work: () => Promise<T>): Promise<T> {
  let span: Span | undefined
  let scope = context.active()
  if (typeof attributes['mikka.run.id_hash'] === 'string') scope = scope.setValue(runHashContext, attributes['mikka.run.id_hash'])
  const startedAt = Date.now()
  try {
    span = trace.getTracer('mikka.cloud-startup').startSpan(name, { attributes }, scope)
    scope = trace.setSpan(scope, span)
  } catch { /* Observation cannot change provisioning. */ }
  try { return await context.with(scope, work) }
  catch (error) {
    try { span?.setAttributes(safeErrorAttributes(error)); span?.setStatus({ code: SpanStatusCode.ERROR }) }
    catch { /* Keep the original failure. */ }
    throw error
  } finally {
    try { span?.end() } catch { /* Observation cannot change provisioning. */ }
    context.with(scope, () => timingLog({ stage: name, startedAt, endedAt: Date.now(), ms: Date.now() - startedAt }))
  }
}

/** Non-overlapping phases of the existing provisioning state machine. No
 * additional provider or database reads are needed to measure a phase. */
export function cloudStartupPhases(attributes: Attributes) {
  let current: Span | undefined
  let phase: string | undefined
  let startedAt = Date.now()
  const phases: { phase: string; startedAt: number; endedAt: number; ms: number }[] = []
  const endCurrent = () => {
    const endedAt = Date.now()
    if (phase) phases.push({ phase, startedAt, endedAt, ms: endedAt - startedAt })
    phase = undefined
    try { current?.end() } catch { /* Observation cannot change provisioning. */ }
    current = undefined
  }
  return {
    next<T extends string>(next: T): T {
      endCurrent()
      phase = next
      startedAt = Date.now()
      try { current = trace.getTracer('mikka.cloud-startup').startSpan(`cloud.thread.${next}`, { attributes }) }
      catch { /* Observation cannot change provisioning. */ }
      return next
    },
    end() { endCurrent(); timingLog({ stage: 'cloud.thread.phases', phases }) },
  }
}

const bootstrapPhases = new Set(['validation', 'source', 'node', 'gh', 'dependencies', 'build', 'cli', 'journal', 'desktop', 'finalize'])

/** Receipts contain a closed stage name and milliseconds only. Remote stdout
 * stays private; package-manager output is never copied to traces. */
export function recordCloudBootstrapPhases(stdout: string, startedAt: number, endedAt: number) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) return
  let offset = 0
  const stages: { name: string; ms: number }[] = []
  for (const line of stdout.split('\n')) {
    const match = /^mikka-bootstrap-phase ([a-z_]+) (\d{1,6})$/.exec(line.trim())
    if (!match || !bootstrapPhases.has(match[1])) continue
    const ms = Number(match[2])
    if (stages.some(stage => stage.name === match[1]) || offset + ms > endedAt - startedAt + 1_000) return
    stages.push({ name: match[1], ms })
    offset += ms
  }
  offset = 0
  for (const stage of stages) {
    try {
      const span = trace.getTracer('mikka.cloud-startup').startSpan(`cloud.bootstrap.${stage.name}`, { startTime: new Date(startedAt + offset) })
      span.end(new Date(startedAt + offset + stage.ms))
    } catch { /* Observation cannot change provisioning. */ }
    offset += stage.ms
  }
  if (stages.length) timingLog({ stage: 'cloud.bootstrap.phases', startedAt, endedAt, phases: stages })
}
