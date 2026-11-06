import 'server-only'
import { afterJob } from './background'
import { useKV } from 'nitro/kv'
import { findAgentImage } from './agent-images'
import { publicImageLookup } from './agent-image-cache'

// Nitro's production Vercel preset mounts this namespace on the existing
// platform runtime cache; the Node preset keeps its normal local KV behavior.
export const findCachedAgentImage = publicImageLookup({
  get: key => useKV('cache:public-wikimedia-images:v1').getItem(key),
  set: (key, value) => useKV('cache:public-wikimedia-images:v1').setItem(key, value),
}, findAgentImage, work => afterJob('after:agent-images.revalidate', work))
