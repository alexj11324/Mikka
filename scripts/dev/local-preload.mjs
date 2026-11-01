// Loaded with `node --import` into the development server only when
// scripts/dev-preview.mjs runs in local mode (docs/dev-workflow.md § 12).
// It never ships in a build and refuses to load anywhere else.
import { localServicesEnabled } from './local-mode.mjs'
import { installLocalTransport } from './local-transport.mjs'

if (!localServicesEnabled(process.env)) throw new Error('Mikka local services preload requires local test-account mode (MIKKA_LOCAL_TEST_ACCOUNTS=1, loopback *_e2e databases) outside production')
installLocalTransport(process.env.MIKKA_LOCAL_SERVICES_ORIGIN)
