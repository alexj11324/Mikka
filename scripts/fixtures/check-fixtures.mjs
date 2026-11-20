import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { recordingMetadata, scenarios, validateFixture } from './schema.mjs'
import { scanSensitive, sha256 } from './sanitize.mjs'

export async function checkRecordedDirectory(directory, { requireLibrary = false } = {}) {
  const names = await readdir(directory), found = new Set(), evidence = []
  for (const name of names.filter(name => name.endsWith('.jsonl'))) {
    const text = await readFile(join(directory, name), 'utf8')
    const lines = await validateFixture(text, { recorded: true })
    let metadata
    try { metadata = recordingMetadata.parse(JSON.parse(await readFile(join(directory, `${name}.metadata.json`), 'utf8'))) } catch { throw new Error('recording_metadata_invalid') }
    if (sha256(text) !== metadata.fixtureSha256) throw new Error('recording_digest_mismatch')
    if (scanSensitive(lines).length || scanSensitive(metadata).length) throw new Error('recording_sensitive_material_remaining')
    const eventTypes = [...new Set(lines.flatMap(line => [line.chunk?.type, line.submit ? 'submit' : null, line.exit ? 'exit' : null].filter(Boolean)))].sort()
    if (JSON.stringify(eventTypes) !== JSON.stringify(metadata.eventTypes)) throw new Error('recording_event_types_drift')
    const key = `${metadata.harness}/${metadata.scenario}`
    if (found.has(key)) throw new Error('recording_duplicate_scenario')
    found.add(key); evidence.push({ harness: metadata.harness, scenario: metadata.scenario, fixtureSha256: metadata.fixtureSha256 })
  }
  const missing = ['claude-code', 'codex'].flatMap(harness => scenarios.filter(scenario => !found.has(`${harness}/${scenario}`)).map(scenario => `${harness}/${scenario}`))
  if (requireLibrary && missing.length) throw new Error(`recording_library_incomplete:${missing.join(',')}`)
  return { validated: evidence.length, missing, evidence }
}

export async function checkFixtures(root = resolve(import.meta.dirname, '../..'), options = {}) {
  const handWritten = join(root, 'packages/daemon/fixtures')
  const names = (await readdir(handWritten)).filter(name => name.endsWith('.jsonl'))
  for (const name of names) await validateFixture(await readFile(join(handWritten, name), 'utf8'))
  return { handWrittenSchemaValidated: names.length, recorded: await checkRecordedDirectory(join(root, 'packages/daemon/fixtures/recorded'), options) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await checkFixtures(undefined, { requireLibrary: process.argv.includes('--require-library') }))) }
  catch (error) { console.error(/^recording_|^fixture_/.test(error.message) ? error.message : 'fixture_check_failed'); process.exitCode = 1 }
}
