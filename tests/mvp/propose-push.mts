import { assertMvpEnvironment, REPOSITORY } from './isolated-env.mjs'

// A synthetic Coordinator proposal, using the real persistence path. The
// browser still has to make the authenticated human decision.
assertMvpEnvironment()
const userId = process.argv[2]
if (!userId) throw new Error('Missing disposable owner')
const { proposeRepositoryPush } = await import('../../lib/pending-action-store')
const { pool } = await import('../../lib/db')
try {
  const proposal = await proposeRepositoryPush(userId, { repo: REPOSITORY })
  if (!('actionId' in proposal) || !proposal.actionId) throw new Error('Proposal failed')
  process.stdout.write(proposal.actionId)
} finally { await pool.end() }
