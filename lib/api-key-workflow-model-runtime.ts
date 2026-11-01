import 'server-only'
import type { LanguageModel } from 'ai'
import { createTrustedGatewayModel } from '@/lib/abuse/model'
import { pool } from '@/lib/db'
import { getWorkspaceApiKeyCredential } from '@/lib/secrets/model-api-key'
import { apiKeyModelSnapshotSchema, type ApiKeyModelSnapshot } from './subscription-model-snapshot'

type V4Model = Extract<LanguageModel, { specificationVersion: 'v4' }>
class ApiKeyModelError extends Error {}

/**
 * A workspace that pins a model-admission policy restricts which transports its
 * runs may use; a bring-your-own key is not one of the fixed admitted transports,
 * so it is denied there (no silent BYOK bypass). Where no policy is configured
 * this is a no-op and ordinary gateway routing applies.
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

/**
 * Re-verify the frozen reference and build the Coordinator's model: the Vercel
 * AI Gateway model for the saved gateway id, with the workspace's key handed to
 * the gateway as a request-scoped BYOK credential for that provider, routed only
 * to that provider. The key never leaves the Node step.
 */
export async function resolveApiKeyWorkflowModel(selection: ApiKeyModelSnapshot, signal?: AbortSignal): Promise<V4Model> {
  if (signal?.aborted) throw new DOMException('Model resolution cancelled', 'AbortError')
  const frozen = apiKeyModelSnapshotSchema.parse(selection)
  await assertApiKeyModelAllowed(frozen.workspaceId)
  await assertBindingLive(frozen)
  const credential = await getWorkspaceApiKeyCredential(frozen.connectionId, frozen.workspaceId)
  const provider = frozen.modelId.split('/')[0]
  if (!provider || provider !== credential.providerSlug) throw new ApiKeyModelError('api_key_model_unavailable')
  const base = await createTrustedGatewayModel(frozen.modelId)
  const gatewayOptions = {
    byok: { [provider]: [{ apiKey: credential.apiKey }] },
    only: [provider],
    order: [provider],
    user: frozen.workspaceId,
  }
  const withByok = <T extends { providerOptions?: Record<string, unknown> }>(args: T): T => ({
    ...args,
    providerOptions: {
      ...args.providerOptions,
      gateway: { ...(args.providerOptions?.gateway as Record<string, unknown> | undefined), ...gatewayOptions },
    },
  })
  // Inject the BYOK credential on every call without serializing it anywhere.
  return new Proxy(base, {
    get(target, property) {
      const member = Reflect.get(target, property, target)
      if ((property === 'doStream' || property === 'doGenerate') && typeof member === 'function') {
        return (args: Parameters<V4Model['doStream']>[0]) => Reflect.apply(member, target, [withByok(args)])
      }
      return member
    },
  })
}
