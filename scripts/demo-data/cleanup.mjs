// Removes the demo rows seed.mjs wrote for one account: only rows whose id starts
// with the prefix (de300000-, or the one passed with --prefix), and, where the
// table has an owner column, only that account's.
//
//   MIKKA_DATABASE_URL=… DATABASE_URL=… node scripts/demo-data/cleanup.mjs --email you@example.com          # dry run: counts
//   MIKKA_DATABASE_URL=… DATABASE_URL=… node scripts/demo-data/cleanup.mjs --email you@example.com --apply  # delete
//
// Safe to run again: a second run finds nothing.
import { connect, countDemoRows, deleteDemoRows, findOwner, inTransaction, MAIN_TABLES, parseArgs, WORKSPACE_TABLES } from './shared.mjs'

const args = parseArgs(process.argv.slice(2))
const db = connect(args)
try {
  const owner = await findOwner(db.main, args.email, args.userId)
  const rows = { main: await countDemoRows(db.main, MAIN_TABLES, owner.id, args.prefix), workspace: await countDemoRows(db.workspace, WORKSPACE_TABLES, owner.id, args.prefix) }
  console.log(JSON.stringify({ mode: args.apply ? 'apply' : 'dry-run', targets: db.targets, owner: { id: owner.id, email: owner.email }, prefix: args.prefix, rows }, null, 2))
  if (args.apply) {
    const deleted = {
      main: await inTransaction(db.main, client => deleteDemoRows(client, MAIN_TABLES, owner.id, args.prefix)),
      workspace: await inTransaction(db.workspace, client => deleteDemoRows(client, WORKSPACE_TABLES, owner.id, args.prefix)),
    }
    console.log(JSON.stringify({ deleted }, null, 2))
  }
} finally {
  await Promise.all([db.main.end(), db.workspace.end()])
}
