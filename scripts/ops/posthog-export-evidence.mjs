#!/usr/bin/env node
// Native PostHog PNG evidence, after the saved target has been verified against
// a real production trace. This script never creates/changes dashboards or insights.
//
//   node scripts/ops/posthog-export-evidence.mjs --dashboard 123
//   node scripts/ops/posthog-export-evidence.mjs --insight 456 --timeout-ms 180000
//
// POSTHOG_PERSONAL_API_KEY comes from the existing Infisical prod:/platform
// workload identity, with export:write/read. Do not put it in CLI arguments.
// Current US OpenAPI: https://us.posthog.com/api/schema/?format=json
// Reference: https://posthog.com/docs/api/exports
// ExportedAssetCreate permits a numeric dashboard/insight and image/png.
// export_context is optional, untyped JSON; omit it instead of guessing internal
// renderer/isotope options or accepting arbitrary paths/URLs.

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { EvidenceError as ExportEvidenceError, publicEvidenceError, readEvidenceBody } from './posthog-evidence-response.mjs'

export const POSTHOG_ORIGIN = 'https://us.posthog.com'
export const PROJECT_ID = 670821
export const REPORT_DIRECTORY = 'production-run-observability-report'
const API = `${POSTHOG_ORIGIN}/api/projects/${PROJECT_ID}/exports/`
const IMAGE_LIMIT = 32 * 1024 * 1024
const JSON_LIMIT = 1024 * 1024
const REQUEST_TIMEOUT_MS = 15000
const STATUS_DELAY_MS = 2000
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

const HELP = `Usage: node scripts/ops/posthog-export-evidence.mjs (--dashboard ID | --insight ID) [--timeout-ms 120000]
IDs must be positive safe integers. Timeout: 1000..300000 ms.
Environment: POSTHOG_PERSONAL_API_KEY (personal phx_ key; export:write/read).
Fixed target: PostHog US project 670821; image/png only.
Output: production-run-observability-report/posthog-<type>-<id>.png and .receipt.json.
Creates one native export; it never creates a dashboard/insight or retries POST.
`

function validId(value) {
  return Number.isSafeInteger(value) && value > 0
}

function validateOptions({ type, id, timeoutMs = 120000 }) {
  if (!['dashboard', 'insight'].includes(type) || !validId(id)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000)
    throw new ExportEvidenceError('invalid_arguments')
  return { type, id, timeoutMs }
}

export function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true }
  const values = new Map()
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]
    const value = args[i + 1]
    if (!['--dashboard', '--insight', '--timeout-ms'].includes(flag)
      || values.has(flag) || !/^[1-9]\d*$/.test(value ?? ''))
      throw new ExportEvidenceError('invalid_arguments')
    values.set(flag, Number(value))
  }
  if (values.has('--dashboard') === values.has('--insight')) throw new ExportEvidenceError('invalid_arguments')
  const type = values.has('--dashboard') ? 'dashboard' : 'insight'
  return validateOptions({ type, id: values.get(`--${type}`), timeoutMs: values.get('--timeout-ms') })
}

function validateAsset(asset, target, phase, expectedExportId) {
  if (!asset || !validId(asset.id) || typeof asset.has_content !== 'boolean')
    throw new ExportEvidenceError('invalid_export_response', { phase })
  if (asset[target.type] !== target.id || asset.export_format !== 'image/png'
    || asset[target.type === 'dashboard' ? 'insight' : 'dashboard'] != null
    || (expectedExportId !== undefined && asset.id !== expectedExportId))
    throw new ExportEvidenceError('export_target_mismatch', { phase })
  if (asset.exception) throw new ExportEvidenceError('export_failed', { phase })
  return asset
}

function pngSize(bytes) {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR'
    || bytes.toString('ascii', bytes.length - 8, bytes.length - 4) !== 'IEND')
    throw new ExportEvidenceError('invalid_png', { phase: 'download' })
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  if (!width || !height) throw new ExportEvidenceError('invalid_png', { phase: 'download' })
  return { width, height }
}

async function atomicWrite(path, data) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, data, { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

export async function exportEvidence(options, {
  key = process.env.POSTHOG_PERSONAL_API_KEY,
  fetchImpl = globalThis.fetch,
  cwd = process.cwd(),
  now = Date.now,
  pause = delay,
} = {}) {
  const target = validateOptions(options)
  if (!key) throw new ExportEvidenceError('missing_personal_api_key')
  if (typeof key !== 'string' || !/^phx_[A-Za-z0-9_-]+$/.test(key))
    throw new ExportEvidenceError('invalid_personal_api_key')

  const started = now(), deadline = started + target.timeoutMs
  const basename = `posthog-${target.type}-${target.id}`
  const directory = join(cwd, REPORT_DIRECTORY)
  const receiptPath = join(directory, `${basename}.receipt.json`)
  let exportId, statusRequests = 0
  const remaining = phase => {
    const ms = deadline - now()
    if (ms <= 0) throw new ExportEvidenceError('deadline_exceeded', { phase })
    return ms
  }
  const baseReceipt = () => ({
    schema_version: 1,
    project_id: PROJECT_ID,
    region: 'US',
    target: { type: target.type, id: target.id },
    format: 'image/png',
    export_id: exportId ?? null,
    started_at: new Date(started).toISOString(),
    finished_at: new Date(now()).toISOString(),
    elapsed_ms: Math.max(0, now() - started),
    status_requests: statusRequests,
  })

  async function request(phase, suffix = '', body) {
    const budget = remaining(phase)
    const controller = new AbortController()
    let timer
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(`${API}${suffix}`, {
            method: body ? 'POST' : 'GET',
            headers: { Authorization: `Bearer ${key}`, Accept: phase === 'download' ? 'image/png' : 'application/json',
              ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
            // The documented content endpoint returns PNG directly. Do not send
            // credentials to a redirect or accept caller/server-provided URLs.
            redirect: 'manual', signal: controller.signal,
          })
          if (response.status >= 300 && response.status < 400)
            throw new ExportEvidenceError('redirect_not_allowed', { phase, httpStatus: response.status })
          if (!response.ok) throw new ExportEvidenceError('http_error', { phase, httpStatus: response.status })
          if (phase === 'download' && response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'image/png')
            throw new ExportEvidenceError('unexpected_content_type', { phase })
          const bytes = await readEvidenceBody(response, phase === 'download' ? IMAGE_LIMIT : JSON_LIMIT, phase)
          if (phase === 'download') return bytes
          try { return JSON.parse(bytes.toString('utf8')) }
          catch (cause) { throw new ExportEvidenceError('invalid_json', { phase, cause }) }
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new ExportEvidenceError(budget <= REQUEST_TIMEOUT_MS ? 'deadline_exceeded' : 'request_timeout', { phase }))
          }, Math.min(REQUEST_TIMEOUT_MS, budget))
        }),
      ])
    } catch (cause) {
      if (cause instanceof ExportEvidenceError) throw cause
      throw new ExportEvidenceError('request_failed', { phase, cause })
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }

  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    // Exactly one POST: a lost response must not silently create duplicate exports.
    let asset = await request('create', '', { [target.type]: target.id, export_format: 'image/png' })
    if (validId(asset?.id)) exportId = asset.id
    validateAsset(asset, target, 'create')
    // Bounded wait for an external export API, never idle polling of Mikka data.
    for (let attempt = 0; !asset.has_content; attempt++) {
      if (attempt >= Math.ceil(target.timeoutMs / STATUS_DELAY_MS))
        throw new ExportEvidenceError('deadline_exceeded', { phase: 'status' })
      await pause(Math.min(STATUS_DELAY_MS, remaining('status')))
      remaining('status')
      statusRequests++
      asset = validateAsset(await request('status', `${exportId}/`), target, 'status', exportId)
    }
    const bytes = await request('download', `${exportId}/content/`)
    const size = pngSize(bytes)
    const receipt = {
      ...baseReceipt(), status: 'complete',
      png: `${REPORT_DIRECTORY}/${basename}.png`,
      receipt: `${REPORT_DIRECTORY}/${basename}.receipt.json`,
      bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...size,
    }
    await atomicWrite(join(directory, `${basename}.png`), bytes)
    await atomicWrite(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
    return receipt
  } catch (cause) {
    const error = cause instanceof ExportEvidenceError ? cause : new ExportEvidenceError('write_failed', { phase: 'write', cause })
    // Failure receipts deliberately exclude response/exception/filename/context.
    // A failed run never attests to an older PNG that may already exist.
    try { await atomicWrite(receiptPath, `${JSON.stringify({ ...baseReceipt(), status: 'failed', error: publicEvidenceError(error) }, null, 2)}\n`) }
    catch (writeCause) { throw new ExportEvidenceError('receipt_write_failed', { phase: 'write', cause: writeCause }) }
    throw error
  }
}

export async function main(args = process.argv.slice(2), { env = process.env, stdout = process.stdout, stderr = process.stderr, ...dependencies } = {}) {
  try {
    const options = parseArguments(args)
    if (options.help) { stdout.write(HELP); return 0 }
    const receipt = await exportEvidence(options, { ...dependencies, key: env.POSTHOG_PERSONAL_API_KEY })
    stdout.write(`${JSON.stringify(receipt)}\n`)
    return 0
  } catch (error) {
    stderr.write(`${JSON.stringify({ status: 'failed', error: publicEvidenceError(error) })}\n`)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main()
