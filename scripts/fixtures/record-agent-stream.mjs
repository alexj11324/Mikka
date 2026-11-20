// Offline import only. There are no network clients or production DB connections.
import { readFile, writeFile, stat, unlink } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { recordingMetadata, scenarios, validateFixture } from './schema.mjs'
import { sanitizeRecording, scanSensitive, sha256 } from './sanitize.mjs'
import { pullRequestSchema } from '../../lib/issue-metadata.ts'

const sourceKeys = ['harness', 'cliVersion', 'runDate', 'sourceRuntime', 'scenario']
export async function convertAgentExport(raw) {
  let exported
  try { exported = JSON.parse(raw) } catch { throw new Error('recording_export_invalid_json') }
  if (exported?.schemaVersion !== 1 || exported.provenance !== 'existing-run-export' || !Array.isArray(exported.events) || !exported.events.length) throw new Error('recording_export_contract_required')
  if (!scenarios.includes(exported.scenario)) throw new Error('recording_scenario_required')
  // The daemon publishes a branch; the server subsequently opens its PR.
  // Keep that separate host observation separate from the adapter's stream.
  const publication = exported.publication
  if (publication !== undefined && (publication?.status !== 'published' || !pullRequestSchema.safeParse(publication.pullRequest).success)) throw new Error('recording_source_publication_invalid')
  const lines = [], types = new Set()
  const first = exported.events[0]
  const origin = first.createdAt ? Date.parse(first.createdAt) : 0
  if (!Number.isFinite(origin)) throw new Error('recording_invalid_timestamp')
  for (const row of exported.events) {
    const t = row.t ?? (Date.parse(row.createdAt) - origin)
    if (!Number.isFinite(t) || t < 0) throw new Error('recording_invalid_timestamp')
    const event = row.event ?? (row.chunk ? { type: 'chunk', chunk: row.chunk } : null)
    if (event?.type === 'chunk') {
      lines.push({ t, chunk: event.chunk }); types.add(event.chunk?.type)
    } else if (event?.type === 'exit') {
      const { type: _type, ...exit } = event
      if (exit.stopReason === 'submitted') {
        if (!exit.report) throw new Error('recording_submit_report_missing')
        lines.push({ t, submit: exit.report }); types.add('submit')
      }
      lines.push({ t, exit }); types.add('exit')
    } else throw new Error('recording_adapter_event_required')
  }
  await validateFixture(lines.map(line => JSON.stringify(line)).join('\n'), { recorded: true })
  if (lines.filter(line => line.exit).length !== 1 || !lines.at(-1).exit) throw new Error('recording_terminal_exit_required')
  const scenario = exported.scenario, exit = lines.at(-1).exit
  const covered = {
    plan: lines.some(line => line.submit?.plan || line.chunk?.type === 'data-spec'),
    question: exit.stopReason === 'asked_human' || Boolean(exit.report?.question),
    tools: types.has('tool-input-available') && (types.has('tool-output-available') || types.has('tool-output-error')),
    'long-running': lines.at(-1).t >= 60_000,
    crash: exit.outcome === 'failed' && typeof exit.error === 'string' && !exit.quota && !exit.providerFailure,
    'success-pr': exit.outcome === 'succeeded' && exit.stopReason === 'submitted' && publication?.status === 'published' && lines.some(line => line.chunk?.type === 'data-publish' && line.chunk.data?.pushed),
    quota: exit.stopReason === 'quota_exhausted' || Boolean(exit.quota),
  }[scenario]
  if (!covered) throw new Error('recording_scenario_not_observed')
  const sanitized = sanitizeRecording(lines)
  const fixture = sanitized.map(line => JSON.stringify(line)).join('\n') + '\n'
  await validateFixture(fixture, { recorded: true })
  const metadata = recordingMetadata.parse({
    schemaVersion: 1, provenance: 'existing-run-export', ...Object.fromEntries(sourceKeys.map(key => [key, exported[key]])),
    sourceSha256: sha256(raw), fixtureSha256: sha256(fixture), eventTypes: [...types].sort(), replayEvidence: [],
    ...(publication ? { sourcePublicationSha256: sha256(JSON.stringify(publication)) } : {}),
  })
  if (scanSensitive(metadata).length || scanSensitive(sanitized).length) throw new Error('recording_sensitive_material_remaining')
  return { fixture, metadata }
}

export async function importAgentExport(input, output) {
  const info = await stat(input)
  if (!info.isFile() || info.size > 50 * 1024 * 1024) throw new Error('recording_input_file_limit')
  const result = await convertAgentExport(await readFile(input, 'utf8'))
  await writeFile(output, result.fixture, { flag: 'wx', mode: 0o600 })
  try { await writeFile(`${output}.metadata.json`, JSON.stringify(result.metadata, null, 2) + '\n', { flag: 'wx', mode: 0o600 }) }
  catch (error) { await unlink(output); throw error }
  return { harness: result.metadata.harness, scenario: result.metadata.scenario, eventTypes: result.metadata.eventTypes, fixtureSha256: result.metadata.fixtureSha256 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output') {
    console.error('Usage: node --import tsx scripts/fixtures/record-agent-stream.mjs --input existing-export.json --output fixture.jsonl')
    process.exitCode = 1
  } else {
    try { console.log(JSON.stringify(await importAgentExport(args[1], args[3]))) }
    catch (error) { console.error(/^recording_|^fixture_/.test(error.message) ? error.message : 'recording_import_failed'); process.exitCode = 1 }
  }
}
