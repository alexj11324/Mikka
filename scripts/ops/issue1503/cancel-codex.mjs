#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { smokeSession, SMOKE_ID, fail } from './http.ts'

const workspaceId = '93f38d33-9447-4eaf-8a46-0d8889165bcd'
const taskId = '5138410f-0b33-42fb-a55f-60017242a8e2'
const issueId = 'e0582e5d-17cd-44e1-b0af-28fc0aace596'
const botId = '388d4bb4-8e1c-4ad0-a1ec-82e387140bd5'
const runId = 'd1f7e459-4576-4994-846f-8afb1ca6492f'
const report = { issue: 1503, phase: 'cancel_unrecoverable_codex_round', startedAt: new Date().toISOString(),
  taskId, issueId, botId, runId, eventId: randomUUID(), status: 'running', attempted: false }
let session
try {
  session = await smokeSession()
  const json = async (path, init = {}) => {
    const response = await session.request(path, { ...init, headers: { ...init.headers, cookie: `mikka-workspace=${workspaceId}`, 'x-mikka-locale': 'en' } })
    const value = await response.json().catch(() => null)
    if (!response.ok || value === null) fail(`cancel_http_${response.status}`)
    return value
  }
  report.productionBuild = (await json('/api/version')).build
  const state = await json(`/api/factory/tasks/${taskId}`)
  const task = state.task
  if (state.liveWorkspaceId !== workspaceId || task?.id !== taskId || task.userId !== SMOKE_ID
    || task.issueId !== issueId || task.botId !== botId) fail('cancel_scope_changed')
  if (task.status === 'cancelled') {
    report.status = 'already_cancelled'
  } else {
    if (task.stage !== 'execute' || task.status !== 'waiting' || task.revision !== 3 || task.candidateId !== null
      || !state.attempts?.some(a => a.id === task.attemptId && a.runId === runId && a.stage === 'execute' && a.status === 'waiting'))
      fail('cancel_state_changed')
    report.attempted = true
    await json(`/api/factory/tasks/${taskId}`, session.post({ binding: { taskId, revision: task.revision },
      eventId: report.eventId, action: 'cancel', reason: 'Issue #1503: the normal shared-subscription continuation was refused. Its evidence is retained; end this acceptance round while the product is fixed.' }))
    const after = await json(`/api/factory/tasks/${taskId}`)
    if (after.task?.id !== taskId || after.task.status !== 'cancelled') fail('cancel_not_confirmed')
    report.status = 'cancelled'
    report.revision = after.task.revision
  }
} catch (error) {
  report.status = 'failed'
  report.code = /^issue1503_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'issue1503_cancel_failed'
  process.exitCode = 1
} finally {
  await session?.close().catch(() => undefined)
  report.completedAt = new Date().toISOString()
  await mkdir('issue1503-report', { recursive: true })
  await writeFile('issue1503-report/cancel-codex.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(report))
}
