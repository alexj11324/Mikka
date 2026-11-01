import 'server-only'
import type { LanguageModel } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { pool } from '@/lib/db'
import { getWorkspaceApiKeyCredential } from '@/lib/secrets/model-api-key'
import { apiKeyModelSnapshotSchema, type ApiKeyModelSnapshot } from './subscription-model-snapshot'

class ApiKeyModelError extends Error {}

/**
 * A workspace that pins a model-admission policy restricts which transports its
 * runs may use; an arbitrary bring-your-own endpoint is not one of the fixed
 * admitted transports, so it is denied there (no silent BYOK bypass). Where no
 * policy is configured this is a no-op and ordinary routing applies.
 */
async function assertApiKeyModelAllowed(workspaceId: string) {
  const { rows } = await pool.query(
    'SELECT 1 FROM workspace_computer_policies WHERE "workspaceId"=$1 AND model_admission IS NOT NULL',
    [workspaceId],
  )
  if (rows.length) throw new ApiKeyModelError('api_key_model_admission_denied')
}

/** The binding and its connection must still be live for this exact model. */
async function assertBindingLive(selection: ApiKeyModelSnapshot) {
  const { rows } = await pool.query(
    `SELECT 1 FROM byos_bindings b JOIN byos_connections n ON n.id=b."connectionId" AND n.state='connected'
     WHERE b.id=$1 AND b."ownerId"=$2 AND b."workspaceId"=$3 AND b."connectionId"=$4 AND b.route='api_key' AND b."modelId"=$5`,
    [selection.bindingId, selection.ownerId, selection.workspaceId, selection.connectionId, selection.modelId],
  )
  if (!rows.length) throw new ApiKeyModelError('api_key_model_unavailable')
}

type V4Model = Extract<LanguageModel, { specificationVersion: 'v4' }>
/** Re-verify the frozen reference and build the OpenAI-compatible model from the sealed key. */
export async function resolveApiKeyWorkflowModel(selection: ApiKeyModelSnapshot, signal?: AbortSignal): Promise<V4Model> {
  if (signal?.aborted) throw new DOMException('Model resolution cancelled', 'AbortError')
  const frozen = apiKeyModelSnapshotSchema.parse(selection)
  await assertApiKeyModelAllowed(frozen.workspaceId)
  await assertBindingLive(frozen)
  const credential = await getWorkspaceApiKeyCredential(frozen.connectionId, frozen.workspaceId)
  const provider = createOpenAICompatible({ name: 'mikka-workspace-api-key', baseURL: credential.baseURL, apiKey: credential.apiKey })
  return provider(frozen.modelId)
}
