// 4e2 item 4: every place cloud-computer / agent output is persisted must pass through the secret masker of
// its workspace and its owner (the owner's own secrets, decision 2026-11-02-2120).
// Peer mailbox text and subagent_events/bot_subagents are checked by write-then-read-back in
// secret-masking.db.test.ts (not by source regex). Behaviour of the maskers is covered in workspace-secrets.db.test.ts; this guards that each write site still calls one.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const points: Array<[string, string, RegExp]> = [
  ['run_chunks (events)', 'app/v1/runs/[runId]/events/route.ts', /secretMaskerFor\(\{ workspaceId: caller\.scopeWorkspaceId, ownerId: caller\.userId \}\)/],
  ['run_chunks (events) persists through the stream masker', 'app/v1/runs/[runId]/events/route.ts', /persistRunEventBatch\(/],
  ['run_chunks stream masking + sealed hold-back', 'lib/secrets/run-events.ts', /maskStreamedChunks\(/],
  ['checkpoint patch is gunzipped before masking', 'lib/secrets/checkpoint.ts', /gunzipSync\(/],
  ['completion result', 'app/v1/runs/[runId]/complete/route.ts', /secretMaskerFor\(\{ workspaceId: caller\.scopeWorkspaceId, ownerId: caller\.userId \}\)/],
  ['run PATCH error', 'app/v1/runs/[runId]/route.ts', /maskFor\(\{ workspaceId: caller\.scopeWorkspaceId, ownerId: caller\.userId \}/],
  ['checkpoint patch/files', 'app/v1/runs/[runId]/checkpoint/route.ts', /maskCheckpoint\(/],
  ['capture owner and workspace scope', 'app/v1/runs/[runId]/captures/route.ts', /const scope = \{ workspaceId: found\.caller\.scopeWorkspaceId, ownerId: found\.owner\.userId \}/],
  ['capture title', 'app/v1/runs/[runId]/captures/route.ts', /title: await maskFor\(scope, parsed\.data\.title\)/],
  ['capture timeline labels', 'app/v1/runs/[runId]/captures/route.ts', /label: await maskFor\(scope, step\.label\)/],
  ['screen capture title', 'app/v1/runs/[runId]/screen/route.ts', /maskFor\(\{ workspaceId: caller\.workspaceId, ownerId: caller\.userId \}/],
  ['MCP report/ask/blocked', 'lib/mcp/worker.ts', /maskForRun\(run\.id/],
  ['MCP artifacts', 'lib/mcp/artifacts.ts', /maskForRun\(/],
  ['pending_actions summary', 'lib/cloud-computer/action-reviews.ts', /maskFor\(\{ workspaceId: actor\.workspaceId, ownerId: actor\.userId \}/],
  ['subagent workflow report', 'workflows/subagent/steps.ts', /maskFor\(\{workspaceId:actor\.workspaceId,ownerId:actor\.userId\}/],
  ['computer review call', 'lib/computer/reviews.ts', /maskDeep\(row\.call, mask\)/],
  ['computer review route passes masker', 'app/v1/devices/[deviceId]/computer/route.ts', /secretMaskerFor\(\{ workspaceId: caller\.scopeWorkspaceId, ownerId: caller\.userId \}\)/],
  ['native coordinator command', 'app/v1/devices/[deviceId]/coordinator/route.ts', /maskFor\(\{ workspaceId: caller\.scopeWorkspaceId, ownerId: caller\.userId \}, body\.command\)/],
]

for (const [name, file, pattern] of points) {
  test(`masking point: ${name}`, () => assert.match(readFileSync(file, 'utf8'), pattern, `${file} must mask before persisting`))
}
