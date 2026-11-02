import { join } from 'node:path'
import { MIN_DAEMON_VERSION } from '@mikka/protocol/device'

/** The oldest served daemon's released client files (scripts/daemon-contract-fixture.mjs). */
export const DAEMON_FIXTURE = join(import.meta.dirname, '..', 'fixtures', `daemon-${MIN_DAEMON_VERSION}`)
