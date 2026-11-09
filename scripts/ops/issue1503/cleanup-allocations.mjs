/** New C v4: bounded, operator-only allocation evidence for issue #1503.
 * This is new code; it does not claim byte identity with the lost v3 helper. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'

const OWNER = 'cL1NXe1mr7WuIS8xWhU37v0p7kNoUMY3'
const WORKSPACE = '93f38d33-9447-4eaf-8a46-0d8889165bcd'
const TEAM = '62a760fc-da79-4d50-a8fa-a818e25d2f9a'
const REPOSITORY = 'alexj11324/Mikka-handoff'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const SANDBOX = /^[a-zA-Z0-9_-]{1,128}$/
const GLOBAL_COUNTS = ['activeOrQueuedRuns', 'pendingFactoryWork', 'pendingThreadProvisioning',
  'pendingCloudProvisioning', 'liveWorkerLeases', 'unfinishedSubagents', 'pendingSandboxKills']
const TERMINAL = new Set(['succeeded', 'failed', 'stopped'])
// Each tuple comes from the saved historical scope; configuration cannot widen it.
export const PINNED_HISTORY = Object.freeze([
  {
    "issueId": "bf272b85-2430-4546-9038-8f3bc6998a5e",
    "taskId": "caaaed63-8648-49b0-b17b-ff45c005876b",
    "runId": "9f49787a-a5e4-437f-8432-c594c713a18e",
    "operationId": "c328c238-dede-421f-9ec7-deb217f12a38",
    "lookup": "legacy_run_metadata"
  },
  {
    "issueId": "bf272b85-2430-4546-9038-8f3bc6998a5e",
    "taskId": "caaaed63-8648-49b0-b17b-ff45c005876b",
    "runId": "e295faed-273c-479f-8c03-9ab9dc2533ee",
    "operationId": "16ab7e20-71f0-48a8-a143-a526142a68cb",
    "lookup": "legacy_run_metadata"
  },
  {
    "issueId": "e0582e5d-17cd-44e1-b0af-28fc0aace596",
    "taskId": "5138410f-0b33-42fb-a55f-60017242a8e2",
    "runId": "d1f7e459-4576-4994-846f-8afb1ca6492f",
    "operationId": "68812218-6272-4022-98a1-a91eba5f3822",
    "lookup": "legacy_run_metadata"
  },
  {
    "issueId": "80f34b1c-4e3a-4d20-b0bd-786d40840bef",
    "taskId": "8c02fbe0-ce49-4223-8888-10eff99d1a8f",
    "runId": "d9a4ebfc-b8c6-48ca-8776-a8935863a488",
    "operationId": "1bb43ed8-277c-46a7-bd2e-001571181ab0",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "f4298bea-9cb0-4fa2-bbff-0e16c33954af",
    "taskId": "994ceba4-dc1a-42a6-9c33-29b954fd3ac2",
    "runId": "6547cb9f-455d-4fe1-8cef-75cdc08e7df0",
    "operationId": "6b130b2e-f94b-432e-8021-7659502b308e",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "97c51483-dea3-4ac3-8088-c4a182fb77ed",
    "taskId": "1f4ee63f-035c-49e1-b2da-0b30ccf414dd",
    "runId": "8af222c0-8143-439d-8fd1-d1a4d3b43a7c",
    "operationId": "21638b1c-47b3-489c-8e0d-c19b27bb7aa7",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "719523d1-b0e5-4b28-823c-485c1e141c5f",
    "taskId": "a3908404-57c9-453b-8539-7069195fac70",
    "runId": "ed6723b7-f39f-4cf4-8243-9e5e9a94225f",
    "operationId": "c6524fbd-4a9e-44d0-9b0d-d24b97b038f7",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "6fa2a3e8-1f4c-4ef4-9057-1d00fff5d4bf",
    "taskId": "e1a83dea-fe74-4a90-bf17-6c7ab5260e89",
    "runId": "4d6b0daf-346b-4e9f-8e71-a767bc6100de",
    "operationId": "86f9926b-0a15-49a8-9f0d-e279977aa0fa",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "6fa2a3e8-1f4c-4ef4-9057-1d00fff5d4bf",
    "taskId": "e1a83dea-fe74-4a90-bf17-6c7ab5260e89",
    "runId": "4491cf36-8828-4096-8a13-578b7ca3d807",
    "operationId": "1d773195-07ff-4a75-b6cd-7bda75745f0e",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "11ba8fa4-9919-4387-8b72-a0e279d41d5f",
    "taskId": "e722dc29-d451-4e4f-a96c-949c6647f460",
    "runId": "5ea7dad6-d3bc-4e9c-83fd-967fb58fa85a",
    "operationId": "999a6cba-584e-443b-888f-54fbb4240e59",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "4fb0b4ec-3a0f-47b4-a3db-4a37fc7f281c",
    "taskId": "7fe4108d-8722-411a-9f7f-ebd1391ab54e",
    "runId": "338b908a-1ada-4791-8cc0-868db7f47afa",
    "operationId": "f7dd8c0c-0fd7-4ae6-9672-fe4d97090bb2",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "45b22130-bc9c-4d62-9553-3b7d847e4120",
    "taskId": "a4f5844c-7c4f-46d9-a304-2cf84598742f",
    "runId": "032f5180-1a44-42bb-82cd-70b0637b16d4",
    "operationId": "a101d3c7-31af-49d4-9bdd-3c655db4e389",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "45b22130-bc9c-4d62-9553-3b7d847e4120",
    "taskId": "a4f5844c-7c4f-46d9-a304-2cf84598742f",
    "runId": "4ad9064f-af19-4e1d-bd2c-e835d6c7b159",
    "operationId": "69684576-232b-4e43-b49e-4375edfc3a13",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "626ffdfd-f24b-4b35-8682-84167a45ffe5",
    "taskId": "77927ba7-096d-4ee2-8b20-9ffc7ae9f539",
    "runId": "5a2fefa4-c7d0-4920-8718-bf8d79cc2e91",
    "operationId": "6538d7b1-fa88-4429-8773-d0e2035776ba",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "626ffdfd-f24b-4b35-8682-84167a45ffe5",
    "taskId": "77927ba7-096d-4ee2-8b20-9ffc7ae9f539",
    "runId": "e33db713-68e5-4e18-8fe3-ee3e1a210c50",
    "operationId": "476f458e-c234-433f-9502-4b61af57dd1e",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "fc33fd19-3482-415c-8e41-2b64b261b27e",
    "taskId": "337bbcf4-d127-4772-9332-e7ced061c621",
    "runId": "8d0667f4-02ac-4205-8014-bfec1a920a9d",
    "operationId": "f391dacd-2b86-4eba-ac15-b408f6bfa8b6",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "fc33fd19-3482-415c-8e41-2b64b261b27e",
    "taskId": "337bbcf4-d127-4772-9332-e7ced061c621",
    "runId": "eee445ca-1eeb-429d-bf8e-8635362ff241",
    "operationId": "ef484e80-2089-4817-92a3-4d8fdada5e89",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "9b4f90bf-9268-4e68-8037-0d12950529cb",
    "taskId": "c687460b-e6a4-44ac-8696-f60d66bf64d3",
    "runId": "0c66bb7d-f166-4deb-81c2-7197c042c6ab",
    "operationId": "acde36fc-c52b-453a-88c4-5a2c95b3cf61",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "9b4f90bf-9268-4e68-8037-0d12950529cb",
    "taskId": "c687460b-e6a4-44ac-8696-f60d66bf64d3",
    "runId": "51f9f9b1-cabd-4530-8147-93c58f9d5ecf",
    "operationId": "8a0295bd-daf8-4b9c-9572-8ee1324b4f69",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "facee344-3cc3-4919-8708-1462f815fb21",
    "taskId": "5919985f-c531-4915-b51e-fea3b1702211",
    "runId": "58a0260d-f0fd-4f38-8c29-3acca904bbdd",
    "operationId": "f32ae3d7-0857-46e5-98fa-1be54b067c64",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "facee344-3cc3-4919-8708-1462f815fb21",
    "taskId": "5919985f-c531-4915-b51e-fea3b1702211",
    "runId": "6fb2b7dd-ca53-4ba7-8d6c-4526a1de227a",
    "operationId": "232ffa5f-831c-47ac-9731-e2b4e18efe8d",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "facee344-3cc3-4919-8708-1462f815fb21",
    "taskId": "5919985f-c531-4915-b51e-fea3b1702211",
    "runId": "7970d2af-b75b-4450-89e3-47f0a8a1154a",
    "operationId": "a2f200cf-28ad-43a4-be76-118ade1660ef",
    "lookup": "operation_metadata"
  }
].map(Object.freeze))
const check = (condition, code) => { if (!condition) throw new Error(`issue1503_cleanup_${code}`) }
const hash = value => createHash('sha256').update(value).digest('hex')
const uuid = value => typeof value === 'string' && UUID.test(value)
const terminalTask = task => ['cancelled', 'revoked'].includes(task.status)
  || (task.stage === 'publish' && task.status === 'passed')
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
const zero = value => value === 0 || value === '0'

function reportCase(raw, expectedHarness) {
  check(raw?.issue === 1503 && raw.phase === 'delivery' && raw.status === 'passed'
    && raw.workspaceId === WORKSPACE && raw.teamId === TEAM && raw.repository === REPOSITORY
    && SHA.test(raw.expectedSha ?? '') && typeof raw.marker === 'string' && raw.marker.length > 0
    && isDeepStrictEqual(raw.selectedHarnesses, [expectedHarness])
    && validTime(raw.startedAt) && validTime(raw.completedAt)
    && Date.parse(raw.completedAt) >= Date.parse(raw.startedAt)
    && Array.isArray(raw.cases) && raw.cases.length === 1, 'passed_report_scope')
  const item = raw.cases[0]
  check(item?.harness === expectedHarness && item.status === 'passed'
    && uuid(item.issueId) && uuid(item.taskId) && item.merge?.source === 'mikka'
    && SHA.test(item.merge.mergeCommitSha ?? '')
    && Array.isArray(item.runIdsSeen) && item.runIdsSeen.length > 0
    && Array.isArray(item.runs), 'passed_case_scope')
  const runs = new Set()
  const add = value => { check(uuid(value), 'receipt_run_id'); runs.add(value) }
  const optional = value => { if (value != null) add(value) }
  for (const id of item.runIdsSeen) add(id)
  for (const run of item.runs) add(run.runId)
  optional(item.threadRunId); optional(item.creation?.runId)
  for (const id of item.dispatchReceipts?.runIds ?? []) add(id)
  for (const candidate of [item.initial, item.repaired]) {
    check(candidate && uuid(candidate.runId), 'candidate_run_missing')
    add(candidate.runId)
    for (const key of ['reviewArtifacts', 'verification', 'checks']) {
      check(Array.isArray(candidate[key]), 'candidate_evidence_missing')
      for (const evidence of candidate[key]) add(evidence.runId)
    }
  }
  const question = item.questionConfirmation
  if (question) {
    check(question.required === true && question.answerAttempted === true
      && question.resolved === true && question.receipt?.source === 'normal_factory_question_api',
    'question_receipt_missing')
    for (const id of [question.origin?.runId, question.continuation?.runId,
      question.receipt.originRunId, question.receipt.continuationRunId]) add(id)
    check(question.origin.runId === question.receipt.originRunId
      && question.continuation.runId === question.receipt.continuationRunId, 'question_run_binding')
  }
  return { issueId: item.issueId, taskId: item.taskId, runIds: [...runs], harness: expectedHarness,
    startedAt: raw.startedAt, completedAt: raw.completedAt, expectedSha: raw.expectedSha }
}

/** Only exact raw receipts authorize future cases. Null placeholders fail before any mutation. */
export async function loadAllocationScope(config, latestPath, read = readFile) {
  check(config?.version === 1 && config.issue === 1503 && config.workspaceId === WORKSPACE
    && config.smokeUserId === OWNER && isDeepStrictEqual(config.historicalAllocations, PINNED_HISTORY)
    && Array.isArray(config.passedReports) && config.passedReports.length === 2,
  'allocation_scope_invalid')
  const receipts = []
  const cases = []
  for (const [i, harness] of ['claude_code', 'codex'].entries()) {
    const entry = config.passedReports[i]
    check(entry?.harness === harness && typeof entry.path === 'string' && entry.path.length > 0
      && SHA256.test(entry.sha256 ?? ''), 'passed_inputs_missing')
    const bytes = await read(entry.path)
    check(hash(bytes) === entry.sha256, 'passed_raw_sha_mismatch')
    const item = reportCase(JSON.parse(Buffer.from(bytes).toString('utf8')), harness)
    cases.push(item); receipts.push({ harness, sha256: entry.sha256, completedAt: item.completedAt })
  }
  check(cases[0].issueId !== cases[1].issueId && cases[0].taskId !== cases[1].taskId
    && cases[0].expectedSha === cases[1].expectedSha, 'passed_case_overlap')
  check(typeof latestPath === 'string' && latestPath.length > 0, 'latest_passed_input_missing')
  const ordered = [...receipts].sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt))
  check(Date.parse(ordered[0].completedAt) < Date.parse(ordered[1].completedAt), 'latest_passed_ambiguous')
  check(hash(await read(latestPath)) === ordered[1].sha256, 'latest_passed_not_chronological')
  const allocations = PINNED_HISTORY.map(item => ({ ...item }))
  for (const item of cases) for (const runId of item.runIds)
    allocations.push({ issueId: item.issueId, taskId: item.taskId, runId, operationId: null, lookup: 'operation_metadata' })
  check(new Set(allocations.map(item => item.runId)).size === allocations.length, 'allocation_run_overlap')
  return { version: 1, ownerId: OWNER, workspaceId: WORKSPACE, mode: 'final_delivery', allocations, receipts,
    latestSuccessfulRawSha256: ordered[1].sha256 }
}

function requireScope(scope) {
  const mode = scope?.mode === undefined ? 'final_delivery' : scope.mode
  const historyLength = mode === 'final_delivery' ? PINNED_HISTORY.length
    : mode === 'failed_release' ? FAILED_RELEASE_HISTORY.length
      : mode === F42606137512_RELEASE_MODE ? F42606137512_HISTORY.length
        : mode === F42636835234_RELEASE_MODE ? F42636835234_HISTORY.length : null
  check(historyLength !== null && scope?.ownerId === OWNER && scope.workspaceId === WORKSPACE
    && Array.isArray(scope.allocations) && scope.allocations.length > historyLength, 'allocation_scope_invalid')
}

/** Whole own-workspace set, including ended/cleared/transferred rows; never filter by phase. */
export function allocationTargets(scope, inventory) {
  requireScope(scope)
  check(Array.isArray(inventory?.threads) && Array.isArray(inventory.tasks), 'inventory_shape')
  const own = inventory.threads.filter(row => row.ownerId === OWNER)
  check(own.length === scope.allocations.length && new Set(own.map(row => row.runId)).size === own.length,
    'allocation_inventory_not_closed')
  const byRun = new Map(own.map(row => [row.runId, row]))
  const allowedTasks = new Set(scope.allocations.map(item => item.taskId))
  const allowedRuns = new Set(scope.allocations.map(item => item.runId))
  check(Array.isArray(inventory.runs) && Array.isArray(inventory.subagents)
    && inventory.runs.every(row => row.userId !== OWNER || allowedRuns.has(row.id))
    && inventory.subagents.every(row => row.ownerId !== OWNER), 'unknown_active_fixture_work')
  for (const task of inventory.tasks)
    if (task.userId === OWNER && !terminalTask(task))
      check(allowedTasks.has(task.id), 'unknown_active_factory_task')
  return scope.allocations.map(expected => {
    const row = byRun.get(expected.runId)
    check(row && row.workspaceId === WORKSPACE && row.issueId === expected.issueId
      && row.runOwnerId === OWNER && row.runIssueId === expected.issueId
      && uuid(row.operationId) && (expected.operationId === null || expected.operationId === row.operationId),
    'allocation_binding_changed')
    const tasks = inventory.tasks.filter(task => task.issueId === expected.issueId)
    check(tasks.length === 1 && tasks[0].id === expected.taskId && tasks[0].userId === OWNER,
      'allocation_task_binding_changed')
    if (row.phase === null) {
      const pin = PINNED_HISTORY[0]
      check(expected.runId === pin.runId && expected.issueId === pin.issueId && expected.taskId === pin.taskId
        && row.operationId === pin.operationId && row.state === 'ended' && row.pending === false
        && row.runStatus === 'succeeded' && row.legacyTerminalAtMatches === true, 'null_phase_not_pinned')
    } else check(typeof row.phase === 'string' && row.phase.length > 0, 'allocation_phase_unknown')
    return { ...expected, operationId: row.operationId, ownerId: OWNER, workspaceId: WORKSPACE,
      state: row.state, pending: row.pending, phase: row.phase, sandboxId: row.sandboxId,
      runStatus: row.runStatus, runFinishedAt: row.runFinishedAt, runLeaseLive: row.runLeaseLive,
      legacyTerminalAtMatches: row.legacyTerminalAtMatches }
  })
}

export function allocationIdentity(targets) {
  return targets.map(item => ({ runId: item.runId, operationId: item.operationId, issueId: item.issueId,
    taskId: item.taskId, ownerId: item.ownerId, workspaceId: item.workspaceId, lookup: item.lookup }))
    .sort((a, b) => a.runId.localeCompare(b.runId))
}

export function assertAllocationIdle(inventory, targets, confirmedAbsent = new Set()) {
  check(inventory && Array.isArray(inventory.runs) && Array.isArray(inventory.subagents)
    && Array.isArray(inventory.clouds) && Array.isArray(inventory.other_sandboxes), 'inventory_shape')
  check(isDeepStrictEqual(Object.keys(inventory.global_activity ?? {}).sort(), [...GLOBAL_COUNTS].sort())
    && GLOBAL_COUNTS.every(key => zero(inventory.global_activity[key])), 'allocation_global_work_pending')
  check(inventory.runs.length === 0 && inventory.subagents.length === 0
    && inventory.tasks.every(terminalTask), 'allocation_fixture_work_pending')
  for (const row of targets) {
    check(row.state === 'ended' && row.pending === false && row.runLeaseLive === false
      && TERMINAL.has(row.runStatus) && validTime(row.runFinishedAt)
      && (row.phase === null || ['retired', 'transferred'].includes(row.phase)), 'allocation_not_terminal')
    if (row.sandboxId != null)
      check(SANDBOX.test(row.sandboxId) && confirmedAbsent.has(row.sandboxId), 'recorded_sandbox_unconfirmed')
  }
  for (const row of inventory.clouds)
    check(row.pending === false && (row.sandboxId != null ? confirmedAbsent.has(row.sandboxId)
      : !['waking', 'running'].includes(row.state)), 'allocation_cloud_work_pending')
}

/** Separate legacy adapter; the modern four-key service is never passed undefined operationId. */
export async function findLegacyCreated(target, { list, options }) {
  const pin = PINNED_HISTORY.find(item => item.runId === target.runId && item.lookup === 'legacy_run_metadata')
  check(pin && target.ownerId === OWNER && target.workspaceId === WORKSPACE
    && target.issueId === pin.issueId && target.taskId === pin.taskId && target.operationId === pin.operationId,
  'legacy_target_not_pinned')
  const metadata = { application: 'mikka-thread', workspaceId: WORKSPACE, runId: pin.runId }
  const pages = list({ ...await options(OWNER), limit: 2, query: { metadata, state: ['running', 'paused'] } })
  const found = await pages.nextItems()
  check(Array.isArray(found) && found.length <= 1 && pages.hasNext === false
    && found.every(item => item?.metadata && Object.entries(metadata).every(([key, value]) => item.metadata[key] === value)),
  'legacy_allocation_identity_unavailable')
  if (!found.length) return null
  const item = found[0]
  check(SANDBOX.test(item.sandboxId ?? '') && ['running', 'paused'].includes(item.state),
    'legacy_allocation_result_invalid')
  return { sandboxId: item.sandboxId, state: item.state }
}

/** All lookups settle and identity/holder checks pass before any residual VM is killed. */
export async function confirmAllocationAbsence(scope, inventory, providers, confirmedAbsent = new Set(), receipt = () => {}) {
  const targets = allocationTargets(scope, inventory)
  assertAllocationIdle(inventory, targets, confirmedAbsent)
  const discovered = []
  for (const target of targets) {
    const found = target.lookup === 'legacy_run_metadata'
      ? await providers.legacy(target)
      : await providers.modern(target.runId, target.workspaceId, target.operationId, target.ownerId)
    check(found === null || (found && SANDBOX.test(found.sandboxId ?? '')
      && ['running', 'paused'].includes(found.state)), 'allocation_provider_result_unknown')
    if (found) {
      check(!inventory.other_sandboxes.some(row => row.sandboxId === found.sandboxId), 'allocation_other_workspace_holder')
      check(!inventory.clouds.some(row => row.sandboxId === found.sandboxId), 'allocation_cloud_holder')
      for (const holder of inventory.threads.filter(row => row.sandboxId === found.sandboxId))
        check(holder.ownerId === OWNER && holder.workspaceId === WORKSPACE && holder.state === 'ended'
          && holder.pending === false && targets.some(item => item.runId === holder.runId), 'allocation_unknown_holder')
    }
    discovered.push({ target, found })
  }
  const ids = discovered.filter(item => item.found).map(item => item.found.sandboxId)
  check(new Set(ids).size === ids.length, 'allocation_duplicate_provider_identity')
  for (const { target, found } of discovered) {
    const identity = { runId: target.runId, operationId: target.operationId, lookup: target.lookup }
    if (found === null) {
      receipt({ ...identity, result: 'no_matching_active_allocation', queriedStates: ['running', 'paused'] })
      continue
    }
    await providers.kill(found.sandboxId, OWNER)
    const after = await providers.info(found.sandboxId, OWNER)
    check(after?.state === 'missing', 'allocation_absence_unconfirmed')
    confirmedAbsent.add(found.sandboxId)
    receipt({ ...identity, sandboxId: found.sandboxId, result: 'killed_and_exact_id_missing' })
  }
  return allocationIdentity(targets)
}

/** Uses an already scheduled inventory read. A changed set blocks every restoration below it. */
export function assertAllocationPostcondition(scope, inventory, priorIdentity, confirmedAbsent) {
  const targets = allocationTargets(scope, inventory)
  assertAllocationIdle(inventory, targets, confirmedAbsent)
  check(isDeepStrictEqual(allocationIdentity(targets), priorIdentity), 'allocation_changed_during_cleanup')
}


/** A separate failed-window scope. It never changes the final-C PASS contract. */
export const FAILED_RELEASE_HISTORY = Object.freeze([
  {
    "issueId": "bf272b85-2430-4546-9038-8f3bc6998a5e",
    "taskId": "caaaed63-8648-49b0-b17b-ff45c005876b",
    "runId": "9f49787a-a5e4-437f-8432-c594c713a18e",
    "operationId": "c328c238-dede-421f-9ec7-deb217f12a38",
    "lookup": "legacy_run_metadata"
  },
  {
    "issueId": "bf272b85-2430-4546-9038-8f3bc6998a5e",
    "taskId": "caaaed63-8648-49b0-b17b-ff45c005876b",
    "runId": "e295faed-273c-479f-8c03-9ab9dc2533ee",
    "operationId": "16ab7e20-71f0-48a8-a143-a526142a68cb",
    "lookup": "legacy_run_metadata"
  },
  {
    "issueId": "e0582e5d-17cd-44e1-b0af-28fc0aace596",
    "taskId": "5138410f-0b33-42fb-a55f-60017242a8e2",
    "runId": "d1f7e459-4576-4994-846f-8afb1ca6492f",
    "operationId": "68812218-6272-4022-98a1-a91eba5f3822",
    "lookup": "legacy_run_metadata"
  },
  {
    "issueId": "80f34b1c-4e3a-4d20-b0bd-786d40840bef",
    "taskId": "8c02fbe0-ce49-4223-8888-10eff99d1a8f",
    "runId": "d9a4ebfc-b8c6-48ca-8776-a8935863a488",
    "operationId": "1bb43ed8-277c-46a7-bd2e-001571181ab0",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "f4298bea-9cb0-4fa2-bbff-0e16c33954af",
    "taskId": "994ceba4-dc1a-42a6-9c33-29b954fd3ac2",
    "runId": "6547cb9f-455d-4fe1-8cef-75cdc08e7df0",
    "operationId": "6b130b2e-f94b-432e-8021-7659502b308e",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "97c51483-dea3-4ac3-8088-c4a182fb77ed",
    "taskId": "1f4ee63f-035c-49e1-b2da-0b30ccf414dd",
    "runId": "8af222c0-8143-439d-8fd1-d1a4d3b43a7c",
    "operationId": "21638b1c-47b3-489c-8e0d-c19b27bb7aa7",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "719523d1-b0e5-4b28-823c-485c1e141c5f",
    "taskId": "a3908404-57c9-453b-8539-7069195fac70",
    "runId": "ed6723b7-f39f-4cf4-8243-9e5e9a94225f",
    "operationId": "c6524fbd-4a9e-44d0-9b0d-d24b97b038f7",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "6fa2a3e8-1f4c-4ef4-9057-1d00fff5d4bf",
    "taskId": "e1a83dea-fe74-4a90-bf17-6c7ab5260e89",
    "runId": "4d6b0daf-346b-4e9f-8e71-a767bc6100de",
    "operationId": "86f9926b-0a15-49a8-9f0d-e279977aa0fa",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "6fa2a3e8-1f4c-4ef4-9057-1d00fff5d4bf",
    "taskId": "e1a83dea-fe74-4a90-bf17-6c7ab5260e89",
    "runId": "4491cf36-8828-4096-8a13-578b7ca3d807",
    "operationId": "1d773195-07ff-4a75-b6cd-7bda75745f0e",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "11ba8fa4-9919-4387-8b72-a0e279d41d5f",
    "taskId": "e722dc29-d451-4e4f-a96c-949c6647f460",
    "runId": "5ea7dad6-d3bc-4e9c-83fd-967fb58fa85a",
    "operationId": "999a6cba-584e-443b-888f-54fbb4240e59",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "4fb0b4ec-3a0f-47b4-a3db-4a37fc7f281c",
    "taskId": "7fe4108d-8722-411a-9f7f-ebd1391ab54e",
    "runId": "338b908a-1ada-4791-8cc0-868db7f47afa",
    "operationId": null,
    "lookup": "operation_metadata"
  },
  {
    "issueId": "45b22130-bc9c-4d62-9553-3b7d847e4120",
    "taskId": "a4f5844c-7c4f-46d9-a304-2cf84598742f",
    "runId": "032f5180-1a44-42bb-82cd-70b0637b16d4",
    "operationId": null,
    "lookup": "operation_metadata"
  },
  {
    "issueId": "45b22130-bc9c-4d62-9553-3b7d847e4120",
    "taskId": "a4f5844c-7c4f-46d9-a304-2cf84598742f",
    "runId": "4ad9064f-af19-4e1d-bd2c-e835d6c7b159",
    "operationId": null,
    "lookup": "operation_metadata"
  }
].map(Object.freeze))
export const FAILED_RELEASE_INPUTS = Object.freeze([
  {
    "harness": "claude_code",
    "path": "issue1503-inputs/factory/claude-code-delivery.json",
    "sha256": "b92c470530ff453febcd55fff7067f4a8bc8a97c0ad0767c9f84b6ae8fa8b8ac",
    "bytes": 13913,
    "issueId": "626ffdfd-f24b-4b35-8682-84167a45ffe5",
    "taskId": "77927ba7-096d-4ee2-8b20-9ffc7ae9f539",
    "runIds": [
      "5a2fefa4-c7d0-4920-8718-bf8d79cc2e91",
      "e33db713-68e5-4e18-8fe3-ee3e1a210c50"
    ]
  },
  {
    "harness": "codex",
    "path": "issue1503-inputs/factory/codex-delivery.json",
    "sha256": "880959791255496145785aee59deafb436915a032e197853edf9d06a7a5c9246",
    "bytes": 16966,
    "issueId": "fc33fd19-3482-415c-8e41-2b64b261b27e",
    "taskId": "337bbcf4-d127-4772-9332-e7ced061c621",
    "runIds": [
      "8d0667f4-02ac-4205-8014-bfec1a920a9d",
      "eee445ca-1eeb-429d-bf8e-8635362ff241"
    ]
  }
].map(item => Object.freeze({ ...item, runIds: Object.freeze(item.runIds) })))

function failedReleaseCase(raw, expected) {
  check(raw?.issue === 1503 && raw.phase === 'delivery' && raw.status === 'failed'
    && raw.workspaceId === WORKSPACE && raw.teamId === TEAM && raw.repository === REPOSITORY
    && raw.expectedSha === 'bb5d1f9e224aea395b9c45823960e8ad10f1a099'
    && raw.marker === '42535538611-1' && isDeepStrictEqual(raw.selectedHarnesses, [expected.harness])
    && validTime(raw.startedAt) && validTime(raw.completedAt)
    && Date.parse(raw.completedAt) >= Date.parse(raw.startedAt)
    && Array.isArray(raw.cases) && raw.cases.length === 1, 'failed_report_scope')
  const item = raw.cases[0]
  check(item?.harness === expected.harness && item.status === 'failed'
    && item.issueId === expected.issueId && item.taskId === expected.taskId
    && Array.isArray(item.runIdsSeen) && item.runIdsSeen.length > 0
    && Array.isArray(item.runs), 'failed_case_scope')
  const runs = new Set()
  const add = id => { check(uuid(id), 'failed_receipt_run_id'); runs.add(id) }
  const optional = id => { if (id != null) add(id) }
  for (const id of item.runIdsSeen) add(id)
  for (const run of item.runs) add(run.runId)
  optional(item.threadRunId); optional(item.creation?.runId)
  for (const id of item.dispatchReceipts?.runIds ?? []) add(id)
  for (const candidate of [item.initial, item.repaired]) {
    if (!candidate) continue
    add(candidate.runId)
    for (const key of ['reviewArtifacts', 'verification', 'checks'])
      for (const evidence of candidate[key] ?? []) add(evidence.runId)
  }
  const question = item.questionConfirmation
  if (question) {
    for (const id of [question.origin?.runId, question.continuation?.runId,
      question.receipt?.originRunId, question.receipt?.continuationRunId]) optional(id)
    check(question.required === true && question.answerAttempted === true
      && question.receipt?.source === 'normal_factory_question_api'
      && question.origin?.runId === question.receipt.originRunId
      && question.continuation?.runId === question.receipt.continuationRunId, 'failed_question_run_binding')
  }
  check(isDeepStrictEqual([...runs].sort(), [...expected.runIds].sort()), 'failed_run_set_changed')
  return { issueId: item.issueId, taskId: item.taskId, runIds: [...runs] }
}

/** Only these two real F186 FAIL originals authorize this release. No PASS is
 * fabricated, and no post-PASS final SQL is read or executed. */
export async function loadFailedAllocationScope(config, latestPath, read = readFile) {
  check(config?.version === 1 && config.issue === 1503 && config.mode === 'failed_release'
    && config.workspaceId === WORKSPACE && config.smokeUserId === OWNER
    && isDeepStrictEqual(config.failedHistoricalAllocations, FAILED_RELEASE_HISTORY)
    && isDeepStrictEqual(config.failedReports, FAILED_RELEASE_INPUTS), 'failed_allocation_scope_invalid')
  const receipts = [], sourceReports = [], cases = []
  for (const entry of FAILED_RELEASE_INPUTS) {
    const bytes = await read(entry.path)
    check(bytes.length === entry.bytes && hash(bytes) === entry.sha256, 'failed_raw_sha_mismatch')
    const raw = JSON.parse(Buffer.from(bytes).toString('utf8'))
    cases.push(failedReleaseCase(raw, entry)); sourceReports.push(raw)
    receipts.push({ harness: entry.harness, sha256: entry.sha256, status: 'failed',
      startedAt: raw.startedAt, completedAt: raw.completedAt })
  }
  check(Date.parse(sourceReports[0].completedAt) < Date.parse(sourceReports[1].startedAt),
    'failed_receipt_chronology_changed')
  check(typeof latestPath === 'string' && latestPath.length > 0
    && hash(await read(latestPath)) === FAILED_RELEASE_INPUTS[1].sha256, 'latest_failed_not_chronological')
  const allocations = FAILED_RELEASE_HISTORY.map(item => ({ ...item }))
  for (const item of cases) for (const runId of item.runIds)
    allocations.push({ issueId: item.issueId, taskId: item.taskId, runId,
      operationId: null, lookup: 'operation_metadata' })
  check(allocations.length === 17 && new Set(allocations.map(item => item.runId)).size === 17,
    'failed_allocation_run_overlap')
  return { version: 1, ownerId: OWNER, workspaceId: WORKSPACE, mode: 'failed_release',
    acceptancePassed: false, allocations, receipts, sourceReports,
    latestFailedRawSha256: FAILED_RELEASE_INPUTS[1].sha256 }
}

/** Exact, independently retained originals from F42606137512. This is a
 * separate failed release; F186 and final PASS admission stay unchanged. */
export const F42606137512_RELEASE_MODE = 'failed_release_42606137512'
export const F42606137512_HISTORY = Object.freeze([
  {
    "issueId": "bf272b85-2430-4546-9038-8f3bc6998a5e",
    "taskId": "caaaed63-8648-49b0-b17b-ff45c005876b",
    "runId": "9f49787a-a5e4-437f-8432-c594c713a18e",
    "operationId": "c328c238-dede-421f-9ec7-deb217f12a38",
    "lookup": "legacy_run_metadata"
  },
  {
    "issueId": "bf272b85-2430-4546-9038-8f3bc6998a5e",
    "taskId": "caaaed63-8648-49b0-b17b-ff45c005876b",
    "runId": "e295faed-273c-479f-8c03-9ab9dc2533ee",
    "operationId": "16ab7e20-71f0-48a8-a143-a526142a68cb",
    "lookup": "legacy_run_metadata"
  },
  {
    "issueId": "e0582e5d-17cd-44e1-b0af-28fc0aace596",
    "taskId": "5138410f-0b33-42fb-a55f-60017242a8e2",
    "runId": "d1f7e459-4576-4994-846f-8afb1ca6492f",
    "operationId": "68812218-6272-4022-98a1-a91eba5f3822",
    "lookup": "legacy_run_metadata"
  },
  {
    "issueId": "80f34b1c-4e3a-4d20-b0bd-786d40840bef",
    "taskId": "8c02fbe0-ce49-4223-8888-10eff99d1a8f",
    "runId": "d9a4ebfc-b8c6-48ca-8776-a8935863a488",
    "operationId": "1bb43ed8-277c-46a7-bd2e-001571181ab0",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "f4298bea-9cb0-4fa2-bbff-0e16c33954af",
    "taskId": "994ceba4-dc1a-42a6-9c33-29b954fd3ac2",
    "runId": "6547cb9f-455d-4fe1-8cef-75cdc08e7df0",
    "operationId": "6b130b2e-f94b-432e-8021-7659502b308e",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "97c51483-dea3-4ac3-8088-c4a182fb77ed",
    "taskId": "1f4ee63f-035c-49e1-b2da-0b30ccf414dd",
    "runId": "8af222c0-8143-439d-8fd1-d1a4d3b43a7c",
    "operationId": "21638b1c-47b3-489c-8e0d-c19b27bb7aa7",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "719523d1-b0e5-4b28-823c-485c1e141c5f",
    "taskId": "a3908404-57c9-453b-8539-7069195fac70",
    "runId": "ed6723b7-f39f-4cf4-8243-9e5e9a94225f",
    "operationId": "c6524fbd-4a9e-44d0-9b0d-d24b97b038f7",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "6fa2a3e8-1f4c-4ef4-9057-1d00fff5d4bf",
    "taskId": "e1a83dea-fe74-4a90-bf17-6c7ab5260e89",
    "runId": "4d6b0daf-346b-4e9f-8e71-a767bc6100de",
    "operationId": "86f9926b-0a15-49a8-9f0d-e279977aa0fa",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "6fa2a3e8-1f4c-4ef4-9057-1d00fff5d4bf",
    "taskId": "e1a83dea-fe74-4a90-bf17-6c7ab5260e89",
    "runId": "4491cf36-8828-4096-8a13-578b7ca3d807",
    "operationId": "1d773195-07ff-4a75-b6cd-7bda75745f0e",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "11ba8fa4-9919-4387-8b72-a0e279d41d5f",
    "taskId": "e722dc29-d451-4e4f-a96c-949c6647f460",
    "runId": "5ea7dad6-d3bc-4e9c-83fd-967fb58fa85a",
    "operationId": "999a6cba-584e-443b-888f-54fbb4240e59",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "4fb0b4ec-3a0f-47b4-a3db-4a37fc7f281c",
    "taskId": "7fe4108d-8722-411a-9f7f-ebd1391ab54e",
    "runId": "338b908a-1ada-4791-8cc0-868db7f47afa",
    "operationId": "f7dd8c0c-0fd7-4ae6-9672-fe4d97090bb2",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "45b22130-bc9c-4d62-9553-3b7d847e4120",
    "taskId": "a4f5844c-7c4f-46d9-a304-2cf84598742f",
    "runId": "032f5180-1a44-42bb-82cd-70b0637b16d4",
    "operationId": "a101d3c7-31af-49d4-9bdd-3c655db4e389",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "45b22130-bc9c-4d62-9553-3b7d847e4120",
    "taskId": "a4f5844c-7c4f-46d9-a304-2cf84598742f",
    "runId": "4ad9064f-af19-4e1d-bd2c-e835d6c7b159",
    "operationId": "69684576-232b-4e43-b49e-4375edfc3a13",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "626ffdfd-f24b-4b35-8682-84167a45ffe5",
    "taskId": "77927ba7-096d-4ee2-8b20-9ffc7ae9f539",
    "runId": "5a2fefa4-c7d0-4920-8718-bf8d79cc2e91",
    "operationId": "6538d7b1-fa88-4429-8773-d0e2035776ba",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "626ffdfd-f24b-4b35-8682-84167a45ffe5",
    "taskId": "77927ba7-096d-4ee2-8b20-9ffc7ae9f539",
    "runId": "e33db713-68e5-4e18-8fe3-ee3e1a210c50",
    "operationId": "476f458e-c234-433f-9502-4b61af57dd1e",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "fc33fd19-3482-415c-8e41-2b64b261b27e",
    "taskId": "337bbcf4-d127-4772-9332-e7ced061c621",
    "runId": "8d0667f4-02ac-4205-8014-bfec1a920a9d",
    "operationId": "f391dacd-2b86-4eba-ac15-b408f6bfa8b6",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "fc33fd19-3482-415c-8e41-2b64b261b27e",
    "taskId": "337bbcf4-d127-4772-9332-e7ced061c621",
    "runId": "eee445ca-1eeb-429d-bf8e-8635362ff241",
    "operationId": "ef484e80-2089-4817-92a3-4d8fdada5e89",
    "lookup": "operation_metadata"
  }
].map(item => Object.freeze(item)))
export const F42606137512_BINDING = Object.freeze({
  "workflowRunId": 42606137512,
  "workflowAttempt": 1,
  "operatorSha": "8fce8f9885fc5edddbc1733063576fd972ea9611",
  "appSha": "a2198c8c2f608f7b8169329b9da853067618dba6",
  "marker": "42606137512-1",
  "fixtureSha256": "2acdf16ec38352f2164601c087461883a4ad5b6deb4011bdaf3a534725efcaa1"
})
export const F42606137512_INPUTS = Object.freeze([
  {
    "harness": "claude_code",
    "path": "issue1503-inputs/factory/claude-code-delivery.json",
    "sha256": "f6ddca13537cb1f2a4e07765931864616f02daf09c98d67dc51cb9da607654ef",
    "bytes": 7888,
    "issueId": "9b4f90bf-9268-4e68-8037-0d12950529cb",
    "taskId": "c687460b-e6a4-44ac-8696-f60d66bf64d3",
    "runIds": [
      "0c66bb7d-f166-4deb-81c2-7197c042c6ab",
      "51f9f9b1-cabd-4530-8147-93c58f9d5ecf"
    ],
    "startedAt": "2026-11-09T11:06:16.907Z",
    "completedAt": "2026-11-09T11:08:49.324Z"
  },
  {
    "harness": "codex",
    "path": "issue1503-inputs/factory/codex-delivery.json",
    "sha256": "67626c8ff479d2815f23ac3232f226a5ae5251224c0c9a410af62c8173759925",
    "bytes": 30166,
    "issueId": "facee344-3cc3-4919-8708-1462f815fb21",
    "taskId": "5919985f-c531-4915-b51e-fea3b1702211",
    "runIds": [
      "58a0260d-f0fd-4f38-8c29-3acca904bbdd",
      "6fb2b7dd-ca53-4ba7-8d6c-4526a1de227a",
      "7970d2af-b75b-4450-89e3-47f0a8a1154a"
    ],
    "startedAt": "2026-11-09T11:08:52.863Z",
    "completedAt": "2026-11-09T11:13:17.885Z"
  }
].map(item => Object.freeze({ ...item, runIds: Object.freeze(item.runIds) })))

function f42606137512Case(raw, expected) {
  check(raw?.issue === 1503 && raw.phase === 'delivery' && raw.status === 'failed'
    && raw.workspaceId === WORKSPACE && raw.teamId === TEAM && raw.repository === REPOSITORY
    && raw.expectedSha === F42606137512_BINDING.appSha
    && raw.marker === F42606137512_BINDING.marker
    && isDeepStrictEqual(raw.selectedHarnesses, [expected.harness])
    && raw.startedAt === expected.startedAt && raw.completedAt === expected.completedAt
    && validTime(raw.startedAt) && validTime(raw.completedAt)
    && Date.parse(raw.completedAt) >= Date.parse(raw.startedAt)
    && Array.isArray(raw.cases) && raw.cases.length === 1, 'f42606137512_report_scope')
  const item = raw.cases[0]
  check(item?.harness === expected.harness && item.status === 'failed'
    && item.issueId === expected.issueId && item.taskId === expected.taskId
    && Array.isArray(item.runIdsSeen) && item.runIdsSeen.length > 0
    && Array.isArray(item.runs), 'f42606137512_case_scope')
  const runs = new Set()
  const add = id => { check(uuid(id), 'f42606137512_run_id'); runs.add(id) }
  const optional = id => { if (id != null) add(id) }
  for (const id of item.runIdsSeen) add(id)
  for (const run of item.runs) add(run.runId)
  optional(item.threadRunId); optional(item.creation?.runId)
  for (const id of item.dispatchReceipts?.runIds ?? []) add(id)
  for (const candidate of [item.initial, item.repaired]) {
    if (!candidate) continue
    add(candidate.runId)
    for (const key of ['reviewArtifacts', 'verification', 'checks'])
      for (const evidence of candidate[key] ?? []) add(evidence.runId)
  }
  const question = item.questionConfirmation
  if (question) {
    for (const id of [question.origin?.runId, question.continuation?.runId,
      question.receipt?.originRunId, question.receipt?.continuationRunId]) optional(id)
    check(question.required === true && question.answerAttempted === true
      && question.receipt?.source === 'normal_factory_question_api'
      && question.origin?.runId === question.receipt.originRunId
      && question.continuation?.runId === question.receipt.continuationRunId,
    'f42606137512_question_binding')
  }
  check(isDeepStrictEqual([...runs].sort(), [...expected.runIds].sort()), 'f42606137512_run_set_changed')
  return { issueId: item.issueId, taskId: item.taskId, runIds: [...runs] }
}

export async function loadF42606137512AllocationScope(config, latestPath, read = readFile) {
  check(config?.version === 1 && config.issue === 1503 && config.mode === F42606137512_RELEASE_MODE
    && config.workspaceId === WORKSPACE && config.smokeUserId === OWNER
    && isDeepStrictEqual(config.source, F42606137512_BINDING)
    && isDeepStrictEqual(config.historicalAllocations, F42606137512_HISTORY)
    && isDeepStrictEqual(config.failedReports, F42606137512_INPUTS), 'f42606137512_allocation_scope_invalid')
  const receipts = [], sourceReports = [], cases = []
  for (const entry of F42606137512_INPUTS) {
    const bytes = await read(entry.path)
    check(bytes.length === entry.bytes && hash(bytes) === entry.sha256, 'f42606137512_raw_sha_mismatch')
    const raw = JSON.parse(Buffer.from(bytes).toString('utf8'))
    cases.push(f42606137512Case(raw, entry)); sourceReports.push(raw)
    receipts.push({ harness: entry.harness, sha256: entry.sha256, status: raw.status,
      startedAt: raw.startedAt, completedAt: raw.completedAt })
  }
  check(Date.parse(sourceReports[0].completedAt) < Date.parse(sourceReports[1].startedAt),
    'f42606137512_chronology_changed')
  check(typeof latestPath === 'string' && latestPath.length > 0
    && hash(await read(latestPath)) === F42606137512_INPUTS[1].sha256, 'f42606137512_latest_mismatch')
  const allocations = F42606137512_HISTORY.map(item => ({ ...item }))
  for (const item of cases) for (const runId of item.runIds)
    allocations.push({ issueId: item.issueId, taskId: item.taskId, runId,
      operationId: null, lookup: 'operation_metadata' })
  check(allocations.length === 22 && new Set(allocations.map(item => item.runId)).size === 22,
    'f42606137512_allocation_run_overlap')
  return { version: 1, ownerId: OWNER, workspaceId: WORKSPACE, mode: F42606137512_RELEASE_MODE,
    acceptancePassed: false, allocations, receipts, sourceReports,
    latestFailedRawSha256: F42606137512_INPUTS[1].sha256 }
}

/** Exact failure-only scope for F42636835234; prior histories and success contracts remain unchanged. */
export const F42636835234_RELEASE_MODE = 'failed_release_42636835234'
export const F42636835234_HISTORY = Object.freeze([
  {
    "issueId": "bf272b85-2430-4546-9038-8f3bc6998a5e",
    "taskId": "caaaed63-8648-49b0-b17b-ff45c005876b",
    "runId": "9f49787a-a5e4-437f-8432-c594c713a18e",
    "operationId": "c328c238-dede-421f-9ec7-deb217f12a38",
    "lookup": "legacy_run_metadata"
  },
  {
    "issueId": "bf272b85-2430-4546-9038-8f3bc6998a5e",
    "taskId": "caaaed63-8648-49b0-b17b-ff45c005876b",
    "runId": "e295faed-273c-479f-8c03-9ab9dc2533ee",
    "operationId": "16ab7e20-71f0-48a8-a143-a526142a68cb",
    "lookup": "legacy_run_metadata"
  },
  {
    "issueId": "e0582e5d-17cd-44e1-b0af-28fc0aace596",
    "taskId": "5138410f-0b33-42fb-a55f-60017242a8e2",
    "runId": "d1f7e459-4576-4994-846f-8afb1ca6492f",
    "operationId": "68812218-6272-4022-98a1-a91eba5f3822",
    "lookup": "legacy_run_metadata"
  },
  {
    "issueId": "80f34b1c-4e3a-4d20-b0bd-786d40840bef",
    "taskId": "8c02fbe0-ce49-4223-8888-10eff99d1a8f",
    "runId": "d9a4ebfc-b8c6-48ca-8776-a8935863a488",
    "operationId": "1bb43ed8-277c-46a7-bd2e-001571181ab0",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "f4298bea-9cb0-4fa2-bbff-0e16c33954af",
    "taskId": "994ceba4-dc1a-42a6-9c33-29b954fd3ac2",
    "runId": "6547cb9f-455d-4fe1-8cef-75cdc08e7df0",
    "operationId": "6b130b2e-f94b-432e-8021-7659502b308e",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "97c51483-dea3-4ac3-8088-c4a182fb77ed",
    "taskId": "1f4ee63f-035c-49e1-b2da-0b30ccf414dd",
    "runId": "8af222c0-8143-439d-8fd1-d1a4d3b43a7c",
    "operationId": "21638b1c-47b3-489c-8e0d-c19b27bb7aa7",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "719523d1-b0e5-4b28-823c-485c1e141c5f",
    "taskId": "a3908404-57c9-453b-8539-7069195fac70",
    "runId": "ed6723b7-f39f-4cf4-8243-9e5e9a94225f",
    "operationId": "c6524fbd-4a9e-44d0-9b0d-d24b97b038f7",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "6fa2a3e8-1f4c-4ef4-9057-1d00fff5d4bf",
    "taskId": "e1a83dea-fe74-4a90-bf17-6c7ab5260e89",
    "runId": "4d6b0daf-346b-4e9f-8e71-a767bc6100de",
    "operationId": "86f9926b-0a15-49a8-9f0d-e279977aa0fa",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "6fa2a3e8-1f4c-4ef4-9057-1d00fff5d4bf",
    "taskId": "e1a83dea-fe74-4a90-bf17-6c7ab5260e89",
    "runId": "4491cf36-8828-4096-8a13-578b7ca3d807",
    "operationId": "1d773195-07ff-4a75-b6cd-7bda75745f0e",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "11ba8fa4-9919-4387-8b72-a0e279d41d5f",
    "taskId": "e722dc29-d451-4e4f-a96c-949c6647f460",
    "runId": "5ea7dad6-d3bc-4e9c-83fd-967fb58fa85a",
    "operationId": "999a6cba-584e-443b-888f-54fbb4240e59",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "4fb0b4ec-3a0f-47b4-a3db-4a37fc7f281c",
    "taskId": "7fe4108d-8722-411a-9f7f-ebd1391ab54e",
    "runId": "338b908a-1ada-4791-8cc0-868db7f47afa",
    "operationId": "f7dd8c0c-0fd7-4ae6-9672-fe4d97090bb2",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "45b22130-bc9c-4d62-9553-3b7d847e4120",
    "taskId": "a4f5844c-7c4f-46d9-a304-2cf84598742f",
    "runId": "032f5180-1a44-42bb-82cd-70b0637b16d4",
    "operationId": "a101d3c7-31af-49d4-9bdd-3c655db4e389",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "45b22130-bc9c-4d62-9553-3b7d847e4120",
    "taskId": "a4f5844c-7c4f-46d9-a304-2cf84598742f",
    "runId": "4ad9064f-af19-4e1d-bd2c-e835d6c7b159",
    "operationId": "69684576-232b-4e43-b49e-4375edfc3a13",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "626ffdfd-f24b-4b35-8682-84167a45ffe5",
    "taskId": "77927ba7-096d-4ee2-8b20-9ffc7ae9f539",
    "runId": "5a2fefa4-c7d0-4920-8718-bf8d79cc2e91",
    "operationId": "6538d7b1-fa88-4429-8773-d0e2035776ba",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "626ffdfd-f24b-4b35-8682-84167a45ffe5",
    "taskId": "77927ba7-096d-4ee2-8b20-9ffc7ae9f539",
    "runId": "e33db713-68e5-4e18-8fe3-ee3e1a210c50",
    "operationId": "476f458e-c234-433f-9502-4b61af57dd1e",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "fc33fd19-3482-415c-8e41-2b64b261b27e",
    "taskId": "337bbcf4-d127-4772-9332-e7ced061c621",
    "runId": "8d0667f4-02ac-4205-8014-bfec1a920a9d",
    "operationId": "f391dacd-2b86-4eba-ac15-b408f6bfa8b6",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "fc33fd19-3482-415c-8e41-2b64b261b27e",
    "taskId": "337bbcf4-d127-4772-9332-e7ced061c621",
    "runId": "eee445ca-1eeb-429d-bf8e-8635362ff241",
    "operationId": "ef484e80-2089-4817-92a3-4d8fdada5e89",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "9b4f90bf-9268-4e68-8037-0d12950529cb",
    "taskId": "c687460b-e6a4-44ac-8696-f60d66bf64d3",
    "runId": "0c66bb7d-f166-4deb-81c2-7197c042c6ab",
    "operationId": "acde36fc-c52b-453a-88c4-5a2c95b3cf61",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "9b4f90bf-9268-4e68-8037-0d12950529cb",
    "taskId": "c687460b-e6a4-44ac-8696-f60d66bf64d3",
    "runId": "51f9f9b1-cabd-4530-8147-93c58f9d5ecf",
    "operationId": "8a0295bd-daf8-4b9c-9572-8ee1324b4f69",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "facee344-3cc3-4919-8708-1462f815fb21",
    "taskId": "5919985f-c531-4915-b51e-fea3b1702211",
    "runId": "58a0260d-f0fd-4f38-8c29-3acca904bbdd",
    "operationId": "f32ae3d7-0857-46e5-98fa-1be54b067c64",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "facee344-3cc3-4919-8708-1462f815fb21",
    "taskId": "5919985f-c531-4915-b51e-fea3b1702211",
    "runId": "6fb2b7dd-ca53-4ba7-8d6c-4526a1de227a",
    "operationId": "232ffa5f-831c-47ac-9731-e2b4e18efe8d",
    "lookup": "operation_metadata"
  },
  {
    "issueId": "facee344-3cc3-4919-8708-1462f815fb21",
    "taskId": "5919985f-c531-4915-b51e-fea3b1702211",
    "runId": "7970d2af-b75b-4450-89e3-47f0a8a1154a",
    "operationId": "a2f200cf-28ad-43a4-be76-118ade1660ef",
    "lookup": "operation_metadata"
  }
])
export const F42636835234_BINDING = Object.freeze({
  "workflowRunId": 42636835234,
  "workflowAttempt": 1,
  "operatorSha": "7017d5f14871cbf1aeea771824d72e1d2bd90255",
  "appSha": "76537e4c2996f717cbd19589e1efae328028aa4a",
  "marker": "42636835234-1",
  "fixtureSha256": "9e0836aa5e5d290dac5c282e82f56907b99207820ded44396159b935c53f9de7"
})
export const F42636835234_INPUTS = Object.freeze([
  {
    "harness": "claude_code",
    "path": "issue1503-inputs/factory/claude-code-delivery.json",
    "sha256": "c95f7c78568b89c2409b7753af00886f53f7c955823cfd60d03b1d4268d2b8fb",
    "bytes": 6985,
    "issueId": "fa86659d-a5f2-48ab-992a-ee75f716d562",
    "taskId": "f695503c-c7fb-40e1-9659-df918f8b1b6e",
    "runIds": [
      "e269de7c-525d-4a1d-88fb-ec5670014b01",
      "532e9734-5b02-4aae-89b5-7a744a6a614d"
    ],
    "startedAt": "2026-11-09T14:40:29.288Z",
    "completedAt": "2026-11-09T15:00:48.484Z"
  },
  {
    "harness": "codex",
    "path": "issue1503-inputs/factory/codex-delivery.json",
    "sha256": "6ecd5fc689cfa792d798f9b66ab4fab605dd996315e7efbbf07a5859a23ab7c8",
    "bytes": 10938,
    "issueId": "c38abb4c-2f8a-48ea-b70b-9f2badda85ee",
    "taskId": "4ad3fce3-a6e8-40b3-9248-df1ea6bc9faf",
    "runIds": [
      "eb28a228-a575-4bc6-8732-ca505a3b2636",
      "0450e5aa-7891-47b9-90db-3a1f6b4b9ca3"
    ],
    "startedAt": "2026-11-09T15:00:52.869Z",
    "completedAt": "2026-11-09T15:06:51.838Z"
  }
].map(item => Object.freeze({ ...item, runIds: Object.freeze(item.runIds) })))

function f42636835234Case(raw, expected) {
  check(raw?.issue === 1503 && raw.phase === 'delivery' && raw.status === 'failed'
    && raw.workspaceId === WORKSPACE && raw.teamId === TEAM && raw.repository === REPOSITORY
    && raw.expectedSha === F42636835234_BINDING.appSha
    && raw.marker === F42636835234_BINDING.marker
    && isDeepStrictEqual(raw.selectedHarnesses, [expected.harness])
    && raw.startedAt === expected.startedAt && raw.completedAt === expected.completedAt
    && validTime(raw.startedAt) && validTime(raw.completedAt)
    && Date.parse(raw.completedAt) >= Date.parse(raw.startedAt)
    && Array.isArray(raw.cases) && raw.cases.length === 1, 'f42636835234_report_scope')
  const item = raw.cases[0]
  check(item?.harness === expected.harness && item.status === 'failed'
    && item.issueId === expected.issueId && item.taskId === expected.taskId
    && Array.isArray(item.runIdsSeen) && item.runIdsSeen.length > 0
    && Array.isArray(item.runs), 'f42636835234_case_scope')
  const runs = new Set()
  const add = id => { check(uuid(id), 'f42636835234_run_id'); runs.add(id) }
  const optional = id => { if (id != null) add(id) }
  for (const id of item.runIdsSeen) add(id)
  for (const run of item.runs) add(run.runId)
  optional(item.threadRunId); optional(item.creation?.runId)
  for (const id of item.dispatchReceipts?.runIds ?? []) add(id)
  for (const candidate of [item.initial, item.repaired]) {
    if (!candidate) continue
    add(candidate.runId)
    for (const key of ['reviewArtifacts', 'verification', 'checks'])
      for (const evidence of candidate[key] ?? []) add(evidence.runId)
  }
  const question = item.questionConfirmation
  check(expected.harness !== 'codex' || question != null, 'f42636835234_question_required')
  if (question) {
    for (const id of [question.origin?.runId, question.continuation?.runId,
      question.receipt?.originRunId, question.receipt?.continuationRunId]) optional(id)
    check(question.required === true && question.answerAttempted === true
      && expected.harness === 'codex'
      && question.receipt?.answerSource === 'human' && question.receipt?.replayed === false
      && question.receipt?.sourceEventId === '2b45eea5-46ca-4bb1-a64f-112ac5650ca7'
      && question.receipt?.source === 'normal_factory_question_api'
      && question.origin?.runId === question.receipt.originRunId
      && question.continuation?.runId === question.receipt.continuationRunId,
    'f42636835234_question_binding')
  }
  check(isDeepStrictEqual([...runs].sort(), [...expected.runIds].sort()), 'f42636835234_run_set_changed')
  return { issueId: item.issueId, taskId: item.taskId, runIds: [...runs] }
}

export async function loadF42636835234AllocationScope(config, latestPath, read = readFile) {
  check(config?.version === 1 && config.issue === 1503 && config.mode === F42636835234_RELEASE_MODE
    && config.workspaceId === WORKSPACE && config.smokeUserId === OWNER
    && isDeepStrictEqual(config.source, F42636835234_BINDING)
    && isDeepStrictEqual(config.historicalAllocations, F42636835234_HISTORY)
    && isDeepStrictEqual(config.failedReports, F42636835234_INPUTS), 'f42636835234_allocation_scope_invalid')
  const receipts = [], sourceReports = [], cases = []
  for (const entry of F42636835234_INPUTS) {
    const bytes = await read(entry.path)
    check(bytes.length === entry.bytes && hash(bytes) === entry.sha256, 'f42636835234_raw_sha_mismatch')
    const raw = JSON.parse(Buffer.from(bytes).toString('utf8'))
    cases.push(f42636835234Case(raw, entry)); sourceReports.push(raw)
    receipts.push({ harness: entry.harness, sha256: entry.sha256, status: raw.status,
      startedAt: raw.startedAt, completedAt: raw.completedAt })
  }
  check(Date.parse(sourceReports[0].completedAt) < Date.parse(sourceReports[1].startedAt),
    'f42636835234_chronology_changed')
  check(typeof latestPath === 'string' && latestPath.length > 0
    && hash(await read(latestPath)) === F42636835234_INPUTS[1].sha256, 'f42636835234_latest_mismatch')
  const allocations = F42636835234_HISTORY.map(item => ({ ...item }))
  for (const item of cases) for (const runId of item.runIds)
    allocations.push({ issueId: item.issueId, taskId: item.taskId, runId,
      operationId: null, lookup: 'operation_metadata' })
  check(allocations.length === 26 && new Set(allocations.map(item => item.runId)).size === 26,
    'f42636835234_allocation_run_overlap')
  return { version: 1, ownerId: OWNER, workspaceId: WORKSPACE, mode: F42636835234_RELEASE_MODE,
    acceptancePassed: false, allocations, receipts, sourceReports,
    latestFailedRawSha256: F42636835234_INPUTS[1].sha256 }
}
