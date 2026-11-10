'use client'

import useSWR, { unstable_serialize } from 'swr'
import { settingsRead } from '@/lib/settings-read'
import { withBasePath } from '@/lib/base-path'
import { settingsReadOptions } from '@/lib/settings-data'
import { settingsKeys } from '@/lib/swr/keys'
import { useLiveKey } from '@/hooks/use-live-key'
import type { EnvironmentsView, EnvironmentView } from '@/app/actions/environments'
import type { SettingsActionResult } from '@/lib/workspace-admin/settings-action'
import type {
  EnvironmentAction, EnvironmentActionKind, EnvironmentSnapshot, RunActionExecutionSummary, RunActionExecutionView,
} from '@/lib/environments/contract'

export type EnvironmentDraft = {
  name: string
  description: string
  runtime: 'cloud' | 'local'
  workdir: string
  setupScript: string
  installScript: string
  actions: EnvironmentAction[]
  repositories: string
  projectId: string | null
  isDefault: boolean
}

export const emptyEnvironmentDraft = (): EnvironmentDraft => ({
  name: '', description: '', runtime: 'cloud', workdir: '', setupScript: '', installScript: '',
  actions: [], repositories: '', projectId: null, isDefault: false,
})

export function environmentDraft(environment: EnvironmentView, duplicate = false): EnvironmentDraft {
  return {
    name: duplicate ? `${environment.name} copy`.slice(0, 80) : environment.name, description: environment.description, runtime: environment.runtime,
    workdir: environment.workdir, setupScript: environment.setupScript, installScript: environment.installScript,
    actions: environment.actions.map(action => ({ ...action })), repositories: environment.repositories.join('\n'),
    projectId: environment.projectId, isDefault: environment.isDefault,
  }
}

export function newAction(kind: EnvironmentActionKind = 'test'): EnvironmentAction {
  return { id: crypto.randomUUID(), name: kind === 'dev' ? 'dev' : kind === 'build' ? 'build' : kind === 'test' ? 'test' : 'run', kind, command: '', timeoutSeconds: 120 }
}

/** The save body. A blank repository line is dropped; the server normalizes keys. */
export function environmentSaveBody(draft: EnvironmentDraft, revision?: number) {
  return {
    ...(revision ? { revision } : {}),
    projectId: draft.projectId,
    isDefault: draft.isDefault,
    config: {
      name: draft.name.trim(), description: draft.description.trim(), runtime: draft.runtime,
      workdir: draft.workdir.trim(), setupScript: draft.setupScript, installScript: draft.installScript,
      actions: draft.actions,
      repositories: draft.repositories.split(/\r?\n|,/).map(value => value.trim()).filter(Boolean),
    },
  }
}

export function useEnvironments(workspaceId: string) {
  const key = settingsKeys.environments(workspaceId)
  const result = useSWR(key, () => settingsRead<SettingsActionResult<EnvironmentsView>>('environments', { workspace: workspaceId }), settingsReadOptions)
  useLiveKey('workspace_settings', workspaceId, [unstable_serialize(key)], workspaceId)
  return result
}

export class RunActionRequestError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code)
    this.name = 'RunActionRequestError'
  }
}

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(withBasePath(path), { credentials: 'same-origin', cache: 'no-store', ...init })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const code = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : 'environmentUnavailable'
    throw new RunActionRequestError(code, response.status)
  }
  return body as T
}

export type RunActionsView = {
  runId: string
  environment: EnvironmentSnapshot | null
  machine: 'cloud_running' | 'local' | 'unavailable'
  executions: RunActionExecutionSummary[]
}

export function useRunActions(runId: string | null, workspaceId: string) {
  const key = runId ? ['run-actions', runId] as const : null
  const result = useSWR(key, () => readJson<RunActionsView>(`/api/runs/${encodeURIComponent(runId!)}/actions`))
  useLiveKey('environment_execution', workspaceId, key ? [unstable_serialize(key)] : [], workspaceId)
  return result
}

export function useRunActionExecution(runId: string | null, executionId: string | null, workspaceId: string) {
  const key = runId && executionId ? ['run-action-execution', runId, executionId] as const : null
  const result = useSWR(key, () => readJson<{ execution: RunActionExecutionView }>(`/api/runs/${encodeURIComponent(runId!)}/actions/${encodeURIComponent(executionId!)}`))
  useLiveKey('environment_execution', workspaceId, key ? [unstable_serialize(key)] : [], workspaceId)
  return result
}

export function requestRunAction(runId: string, actionId: string, requestKey: string) {
  return readJson<{ execution: RunActionExecutionView; replayed?: true }>(`/api/runs/${encodeURIComponent(runId)}/actions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actionId, requestKey }),
  })
}

export function cancelRunAction(runId: string, executionId: string) {
  return readJson<{ execution: RunActionExecutionView | null }>(
    `/api/runs/${encodeURIComponent(runId)}/actions/${encodeURIComponent(executionId)}/cancel`, { method: 'POST' })
}
