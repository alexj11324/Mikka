/** Bound only this migration connection; never change global database settings. */
export async function configureMigrationSession(client) {
  await client.query("SELECT set_config('lock_timeout', '5s', false), set_config('statement_timeout', '60s', false)")
}
