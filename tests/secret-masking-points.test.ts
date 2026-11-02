// 4e2 item 4: every place cloud-computer / agent output is persisted must pass through the workspace secret masker.
// Peer mailbox text and subagent_events/bot_subagents are checked by write-then-read-back in
// secret-masking.db.test.ts (not by source regex). Behaviour of the maskers is covered in workspace-secrets.db.test.ts; this guards that each write site still calls one.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const points: Array<[string, string, RegExp]> = [
  ['run_chunks (events)', 'app/v1/runs/[runId]/events/route.ts', /workspaceSecretMasker\(caller\.scopeWorkspaceId\)/],
  ['run_chunks (events) persists through the stream masker', 'app/v1/runs/[runId]/events/route.ts', /persistRunEventBatch\(/],
  ['run_chunks stream masking + sealed hold-back', 'lib/secrets/run-events.ts', /maskStreamedChunks\(/],
  ['checkpoint patch is gunzipped before masking', 'lib/secrets/checkpoint.ts', /gunzipSync\(/],
  ['completion result', 'app/v1/runs/[runId]/complete/route.ts', /workspaceSecretMasker|maskForWorkspace/],
  ['run PATCH error', 'app/v1/runs/[runId]/route.ts', /maskForWorkspace\(caller\.scopeWorkspaceId/],
  ['checkpoint patch/files', 'app/v1/runs/[runId]/checkpoint/route.ts', /maskCheckpoint\(/],
  ['capture title', 'app/v1/runs/[runId]/captures/route.ts', /maskForWorkspace\(|workspaceSecretMasker\(/],
  ['screen capture title', 'app/v1/runs/[runId]/screen/route.ts', /maskForWorkspace\(|workspaceSecretMasker\(/],
  ['MCP report/ask/blocked', 'lib/mcp/worker.ts', /maskForRun\(run\.id/],
  ['MCP artifacts', 'lib/mcp/artifacts.ts', /maskForRun\(/],
  ['pending_actions summary', 'lib/cloud-computer/action-reviews.ts', /maskForWorkspace\(|workspaceSecretMasker\(/],
  ['subagent workflow report', 'workflows/subagent/steps.ts', /maskForWorkspace\(actor\.workspaceId/],
  ['computer review call', 'lib/computer/reviews.ts', /maskDeep\(row\.call, mask\)/],
  ['computer review route passes masker', 'app/v1/devices/[deviceId]/computer/route.ts', /workspaceSecretMasker\(caller\.scopeWorkspaceId\)/],
  ['native coordinator command', 'app/v1/devices/[deviceId]/coordinator/route.ts', /maskForWorkspace\(caller\.scopeWorkspaceId, body\.command\)/],
]

for (const [name, file, pattern] of points) {
  test(`masking point: ${name}`, () => assert.match(readFileSync(file, 'utf8'), pattern, `${file} must mask before persisting`))
}
