import 'server-only'
import { pool } from '@/lib/db'
import { WORKSPACE_ID } from '@/lib/device-link'
import { SessionMailbox } from '@/lib/session-mailbox'

// Request-scoped pool preserves the app's existing tenant database boundary.
export const mailboxes = new SessionMailbox(pool, WORKSPACE_ID)
