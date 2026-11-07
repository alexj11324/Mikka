import 'server-only'
import { pool } from '@/lib/db'
import { readServerSession } from '@/lib/server-admin'
import { readGitHubAppConfig, saveGitHubAppConfig } from './app-config'
import { githubManifestHandlers } from './manifest-http'
import { GITHUB_APP_MANIFEST_TEMPLATE } from './manifest-template'

export const githubAppManifestRoutes = githubManifestHandlers({
  query: pool, session: readServerSession, config: readGitHubAppConfig, save: saveGitHubAppConfig,
  template: GITHUB_APP_MANIFEST_TEMPLATE,
})
