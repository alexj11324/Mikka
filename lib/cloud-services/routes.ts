import 'server-only'
import { pool } from '@/lib/db'
import { isCloudEdition } from '@/lib/edition'
import { isServerAdmin, readServerSession } from '@/lib/server-admin'
import { ownerSettingsChanged } from '@/lib/live/lists'
import { cloudHandlers } from './http'
import { cloudClient } from './runtime'

export const cloudRoutes = cloudHandlers({ client: cloudClient, session: readServerSession, administrator: isServerAdmin,
  community: () => !isCloudEdition(), changed: userId => ownerSettingsChanged(pool, userId) })
