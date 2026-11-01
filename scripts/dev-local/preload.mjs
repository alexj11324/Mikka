// `next dev` preload for pnpm dev:local only (NODE_OPTIONS=--import). Never
// imported by application code; refuses to load outside local test mode.
import { installDevLocalTransport } from './transport.mjs'

installDevLocalTransport()
