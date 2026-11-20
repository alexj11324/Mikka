import { uiMessageChunkSchema } from 'ai'
import { z } from 'zod'
import { runPublish, runReport, runStopReason } from '../../packages/protocol/src/run.ts'
import { planSpec } from '../../packages/protocol/src/plan.ts'
import { runStateSchema } from '../../packages/protocol/src/daemon.ts'
import { providerFailureSchema } from '../../packages/protocol/src/provider-failure.ts'
import { parseFixture } from '../../packages/daemon/src/adapters/mock.ts'

export const scenarios = ['plan', 'question', 'tools', 'long-running', 'crash', 'success-pr', 'quota']
export const recordingMetadata = z.object({
  schemaVersion: z.literal(1),
  provenance: z.literal('existing-run-export'),
  harness: z.enum(['claude-code', 'codex']),
  cliVersion: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/),
  runDate: z.iso.date(),
  scenario: z.enum(scenarios),
  sourceRuntime: z.enum(['device', 'e2b']),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourcePublicationSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  fixtureSha256: z.string().regex(/^[a-f0-9]{64}$/),
  eventTypes: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,80}$/)).min(1),
  replayEvidence: z.array(z.never()).length(0),
}).strict()

const report = runReport.pick({ summary: true, openQuestions: true, nextStep: true, blockedOn: true, plan: true, criteria: true, question: true, previewDatabaseBranch: true, verificationCommand: true, repositorySelection: true, reviewVerdict: true, visualEvidence: true }).partial().strict()
const exitSchema = z.object({
  outcome: z.enum(['succeeded', 'failed', 'cancelled']), stopReason: runStopReason.optional(), error: z.string().optional(),
  report: report.optional(), sessionExited: z.literal(false).optional(),
  quota: z.object({ resetsAt: z.iso.datetime({ offset: true }).nullable() }).strict().optional(),
  providerFailure: providerFailureSchema.optional(),
}).strict()

// UIMessageChunk permits arbitrary data-* payloads. Check Mikka's actual
// protocol payloads too; an unfamiliar data part needs an explicit review.
const dataSchemas = {
  'data-file-change': z.object({ path: z.string(), change: z.enum(['added', 'modified', 'deleted']) }).strict(),
  'data-usage': z.object({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(), costUsd: z.number().nonnegative().nullable(), source: z.string() }).strict(),
  'data-publish': runPublish.strict(),
  'data-spec': planSpec.extend({ specId: z.uuid() }).strict(),
  'data-split': z.object({ specId: z.uuid(), summary: z.string(), issues: z.array(z.object({ key: z.string(), title: z.string(), note: z.string(), criteria: z.array(z.string()), blockedBy: z.array(z.string()), parentKey: z.string().optional() }).strict()) }).strict(),
  'data-run-state': z.object({ state: runStateSchema, error: z.string().optional(), stopReason: runStopReason.optional() }).strict(),
  'data-run-stage': z.object({ stage: z.enum(['repository', 'worktree', 'agent_start']), ms: z.number().nonnegative(), ok: z.boolean() }).strict(),
  'data-computer': z.object({ botId: z.string(), runId: z.string(), task: z.string(), state: z.literal('working') }).strict(),
}

/** Validate against the installed AI SDK and the actual daemon parser, rather
 * than a second handwritten list of chunk names. No fixture commands execute. */
export async function validateFixture(text, { recorded = false } = {}) {
  let lines
  try { lines = parseFixture(text) } catch { throw new Error('fixture_daemon_schema_invalid') }
  if (!lines.length) throw new Error('fixture_empty')
  let time = -1
  for (const [index, line] of lines.entries()) {
    if (!Number.isFinite(line.t) || line.t < 0 || line.t < time) throw new Error(`fixture_invalid_time:${index + 1}`)
    time = line.t
    if (recorded && Object.keys(line).some(key => !['t', 'chunk', 'submit', 'exit'].includes(key))) throw new Error(`fixture_recorded_side_effect:${index + 1}`)
    if (line.chunk && !(await uiMessageChunkSchema().validate(line.chunk)).success) throw new Error(`fixture_chunk_schema_invalid:${index + 1}`)
    if (line.chunk?.type.startsWith('data-') && !dataSchemas[line.chunk.type]?.safeParse(line.chunk.data).success) throw new Error(`fixture_data_schema_invalid:${index + 1}`)
    if (line.submit && !report.safeParse(line.submit).success) throw new Error(`fixture_report_schema_invalid:${index + 1}`)
    if (line.exit && !exitSchema.safeParse(line.exit).success) throw new Error(`fixture_exit_schema_invalid:${index + 1}`)
  }
  return lines
}
