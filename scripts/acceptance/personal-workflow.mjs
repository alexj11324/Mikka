#!/usr/bin/env node
/** Personal target adapter for the existing subscription and Files acceptance drivers. */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseOptions, runCloudStartup, startupFailure } from './cloud-startup.mjs'
import { runCodingWorkspaceAcceptance } from './coding-workspace.mjs'

export function parsePersonalOptions(args, env = process.env) {
  const rest = [], probes = []
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--probe') probes.push(args[++index])
    else rest.push(args[index])
  }
  const probe = probes[0] ?? 'startup'
  if (probes.length > 1 || !['startup', 'files'].includes(probe)) throw new Error('startup_personal_options_invalid')
  const options = parseOptions(['--workspace-kind', 'personal', '--mode', 'candidate', '--runs', '1',
    '--output', '.cache/acceptance/personal-workflow.json', ...rest], env)
  if (!options.help && (options.workspaceKind !== 'personal' || options.alignReport)) throw new Error('startup_personal_options_invalid')
  return { ...options, probe }
}

export async function runPersonalWorkflow(options, dependencies = {}) {
  if (options?.workspaceKind !== 'personal') throw new Error('startup_personal_options_invalid')
  if (options.probe !== undefined && !['startup', 'files'].includes(options.probe)) throw new Error('startup_personal_options_invalid')
  if (options.probe !== 'files') return runCloudStartup(options, dependencies)
  return runCodingWorkspaceAcceptance({ sourceCommit: options.expectedBuild, workerSha: options.expectedWorkerSha,
    workerSourceCommit: options.expectedWorkerSource, workspaceKind: 'personal', workspace: options.workspace,
    origin: options.origin, operation: options.operation, harness: options.harness, deviceId: options.deviceId, agentId: options.agentId }, dependencies)
}

const HELP = `Personal workflow acceptance

Metadata only; no model prompt, provider lease, Bot, profile or run:
  node --import tsx scripts/acceptance/personal-workflow.mjs --origin http://127.0.0.1:3000 --workspace UUID

One deliberate native subscription attempt on an existing local device:
  node --import tsx scripts/acceptance/personal-workflow.mjs --workspace UUID --operation execute --harness codex --device-id UUID --agent-id UUID --expected-build SHA --revision SHA
Repeat independently with --harness claude_code and its originally bound Agent/subscription.
The models stay gpt-6-luna and claude-haiku-5-5; one passing case does not cover both.

--probe files reuses the Files driver and additionally requires --expected-worker-sha SHA
and --expected-worker-source SHA. Its immutable installed-worker receipt remains required.
Credentials use the existing SMOKE_OWNER_EMAIL/PASSWORD environment binding. No host CLI identity is imported.
Readiness can report ready_for_attempt; it never reports successful model execution.
`

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parsePersonalOptions(process.argv.slice(2))
    if (options.help) console.log(HELP)
    else {
      const report = await runPersonalWorkflow(options)
      const output = resolve(options.output)
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
      console.log(JSON.stringify({ status: report.status, output, executionVerified: report.executionVerified ?? false }))
      if (['failed', 'blocked'].includes(report.status)) process.exitCode = 1
    }
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', failure: startupFailure(error) }))
    process.exitCode = 1
  }
}
