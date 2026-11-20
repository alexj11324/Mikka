import { FAKE_MODEL_KEY } from '../../tests/fakes/litellm.mjs'
import { LOCAL_LITELLM_KEY, LOCAL_LITELLM_URL } from './services.mjs'

/** Inherited credentials can never silently select live model acceptance. */
export function localModelEnvironment(env = process.env) {
  if (env.MIKKA_LOCAL_LIVE_MODELS !== '1') return {
    MIKKA_LITELLM_URL: LOCAL_LITELLM_URL,
    MIKKA_LITELLM_MASTER_KEY: LOCAL_LITELLM_KEY,
    DEEPSEEK_API_KEY: FAKE_MODEL_KEY,
  }
  if (env.CI || env.GITHUB_ACTIONS || env.LOCAL_LOOP_ITEMS || env.MIKKA_LOCAL_LOOP === '1') throw new Error('Live models are forbidden in acceptance and CI')
  if (!env.MIKKA_LITELLM_URL || !env.MIKKA_LITELLM_MASTER_KEY || !env.DEEPSEEK_API_KEY) throw new Error('Manual live mode requires an explicit LiteLLM URL, service key and provider key')
  return { MIKKA_LITELLM_URL: env.MIKKA_LITELLM_URL, MIKKA_LITELLM_MASTER_KEY: env.MIKKA_LITELLM_MASTER_KEY, DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY }
}
