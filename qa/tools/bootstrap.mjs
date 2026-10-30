import { bootstrapEnvironment, recordRunnerEvidenceSecrets } from '/home/user/Mikka/scripts/test-accounts/bootstrap.mjs'
const env = process.env
const d = await bootstrapEnvironment({
  connectionString: env.E2E_DATABASE_URL, origin: env.BETTER_AUTH_URL, deploymentSha: env.MIKKA_TEST_DEPLOYMENT_SHA,
  id: 'local-qa-sweep-1030', outputFile: '.cache/e2e/environment.json',
  authorizeDatabase: async pool => {
    const s = (await pool.query('SELECT inet_server_addr() AS address, inet_server_port() AS port, current_database() db')).rows[0]
    if (!s.address || s.port !== 5432 || s.db !== 'mikka_e2e') throw new Error('not owned')
  },
})
await recordRunnerEvidenceSecrets(d)
console.log(JSON.stringify({ id: d.id, sha: d.deploymentSha, origin: d.origin }))
