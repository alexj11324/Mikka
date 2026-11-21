#!/usr/bin/env node
// Writes lib/model-catalog-snapshot.json: the featured models of the Vercel AI
// Gateway catalogue (lib/model-catalog.ts FEATURED_MODELS), so builds and tests
// have a catalogue without the network. Usage:
//   node --import tsx scripts/model-catalog-snapshot.mjs models.json
import { readFile, writeFile } from 'node:fs/promises'
import { FEATURED_MODELS, parseGatewayModel } from '../lib/model-catalog.ts'

const source = process.argv[2]
if (!source) throw new Error('Supply a model catalogue JSON export from LiteLLM')
const body = JSON.parse(await readFile(source, 'utf8'))
const parsed = new Map((body.data ?? []).map(parseGatewayModel).filter(Boolean).map(model => [model.id, model]))
const missing = FEATURED_MODELS.filter(id => !parsed.has(id))
if (missing.length) throw new Error(`Featured models missing from the Gateway list: ${missing.join(', ')}`)
await writeFile(new URL('../lib/model-catalog-snapshot.json', import.meta.url), `${JSON.stringify(FEATURED_MODELS.map(id => parsed.get(id)), null, 1)}\n`)
console.log(`wrote ${FEATURED_MODELS.length} models`)
