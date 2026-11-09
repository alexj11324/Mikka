/** Explicit post-deploy data repair; never invoked by GET, build or migrations.
 * Uses the deployment's existing application/workspace database and Artifact
 * storage configuration. Do not put credentials in command-line arguments.
 *
 * node --conditions=react-server --import tsx scripts/ops/backfill-factory-spec-artifacts.ts --user-id OWNER
 * Add --apply to write the inspected batch. Pass its `cursor` to apply that exact
 * batch, or `nextCursor` to continue the same mode. Each call handles at most 100
 * completed attempts; restarting from the first cursor is safe and idempotent.
 */
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const usage = 'Usage: --user-id OWNER [--limit 1..100] [--cursor BASE64URL] [--apply]';

async function main() {
  const { values } = parseArgs({ options: {
    'user-id': { type: 'string' }, limit: { type: 'string' }, cursor: { type: 'string' },
    apply: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  }, strict: true, allowPositionals: false });
  if (values.help) { console.log(usage); return; }
  const limit = values.limit === undefined ? 50 : Number(values.limit);
  if (!values['user-id']?.trim() || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    console.error(usage); process.exitCode = 1; return;
  }
  let cursor: unknown;
  if (values.cursor) {
    if (values.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(values.cursor)) { console.error(usage); process.exitCode = 1; return; }
    cursor = JSON.parse(Buffer.from(values.cursor, 'base64url').toString('utf8'));
  }
  const [{ pool }, { workspacePool }, { createFactoryHumanStore }, { createFactoryStore }, { factoryAuthorize }, backfill] = await Promise.all([
    import('../../lib/db/index'), import('../../lib/workspace-db'), import('../../lib/factory/human-store'),
    import('../../lib/factory/store'), import('../../lib/factory/authorize'), import('../../lib/factory/spec-artifact-backfill'),
  ]);
  try {
    const parsed = cursor === undefined ? undefined : backfill.factorySpecBackfillCursorSchema.parse(cursor);
    const store = createFactoryHumanStore(pool, botId => createFactoryStore(pool, factoryAuthorize, botId));
    const result = await backfill.backfillFactorySpecArtifacts(pool, store, values['user-id'], { limit, cursor: parsed, dryRun: !values.apply });
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    // Counts and opaque continuation only: no plan text, credential, prompt,
    // database URL, user profile or run-session identifier reaches stdout.
    console.log(JSON.stringify({ ...result, cursor: encode(result.cursor), nextCursor: result.nextCursor ? encode(result.nextCursor) : null }));
  } finally { await Promise.all([pool.end(), workspacePool.end()]); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(error => {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^factory[A-Za-z]+$/.test(error.code)
    ? error.code : error instanceof Error ? error.name : 'Error';
  console.error(JSON.stringify({ operation: 'backfill-factory-spec-artifacts', error: code }));
  process.exitCode = 1;
});
