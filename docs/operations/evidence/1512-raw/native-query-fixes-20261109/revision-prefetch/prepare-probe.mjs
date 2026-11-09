import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const root = dirname(fileURLToPath(import.meta.url))
const source = '/workspace/scratch/812e3b7d6d45/Mikka-1512-resume'
const require = createRequire(`${source}/package.json`)
const ts = require('typescript')
const sha = text => createHash('sha256').update(text).digest('hex')
const manifest = { kind: 'offline-source-copy-controlled-dependency-probe', source, sourceFiles: [], extraction: [], variants: {}, limitations: ['No production query, PostgreSQL server, network, real model or Native lifecycle.', 'Original action function bodies are extracted byte-for-byte with the TypeScript AST. Auth, workspace database, data DSL, log and other dependencies are controlled fixtures.', 'Only actual live_revisions query calls are counted. Fixture business reads are not a total SQL measurement.'] }
const sourceTexts = new Map()
async function original(path) {
  if (!sourceTexts.has(path)) {
    const text = await readFile(`${source}/${path}`, 'utf8')
    sourceTexts.set(path, text)
    manifest.sourceFiles.push({ path, bytes: Buffer.byteLength(text), sha256: sha(text) })
  }
  return sourceTexts.get(path)
}
function once(text, before, after) {
  if (text.split(before).length !== 2) throw new Error(`Non-unique patch anchor: ${before.slice(0, 90)}`)
  return text.replace(before, after)
}
function transpile(text, path) {
  return ts.transpileModule(text, { fileName: path, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
    .replace(/^import ['"]server-only['"];?\s*$/mg, '')
    .replace(/(from\s*['"]|import\s*\(\s*['"])(\.{1,2}\/[^'"]+)(['"])/g, (all, pre, specifier, end) => `${pre}${specifier.replace(/\.ts$/, '').replace(/(?<!\.mjs)$/, '.mjs')}${end}`)
}
async function put(variant, path, text) {
  const target = resolve(root, variant, path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, text)
  return relative(root, target)
}
async function module(variant, path, text) {
  await put(variant, path, text)
  await put(variant, path.replace(/\.ts$/, '.mjs'), transpile(text, path))
}
async function extracted(path, names, imports) {
  const text = await original(path)
  const tree = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const nodes = []
  for (const name of names) {
    const node = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name
      || ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === name))
    if (!node) throw new Error(`Missing exact source declaration: ${path} ${name}`)
    const value = node.getText(tree)
    nodes.push(value)
    if (!manifest.extraction.some(row => row.path === path && row.name === name)) manifest.extraction.push({ path, name,
      startLine: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
      endLine: tree.getLineAndCharacterOfPosition(node.end).line + 1, sha256: sha(value) })
  }
  const namesToExport = names.filter(name => !nodes[names.indexOf(name)].startsWith('export '))
  return `${imports}\n\n${nodes.join('\n\n')}\n${namesToExport.length ? `export { ${namesToExport.join(', ')} }` : ''}\n`
}

const copies = ['lib/action-error.ts', 'lib/workspace-error.ts', 'lib/cache-read-action.ts', 'lib/list-poll.ts',
  'lib/desktop-rpc/read-batch.ts', 'lib/desktop-rpc/read-batch-context.ts', 'lib/desktop-rpc/read-batch-contract.ts',
  'lib/live/events.ts', 'lib/live/revisions.ts', 'lib/live/owner-scope.ts', 'lib/live/revision-read.ts', 'lib/live/list-read-server.ts',
  'lib/desktop-rpc/read-batch-context.test.ts']

for (const variant of ['baseline', 'prototype']) {
  for (const path of copies) {
    let text = await original(path)
    if (variant === 'prototype' && path === 'lib/desktop-rpc/read-batch-contract.ts') text += `\n// Probe-only proposal; never installed into the product checkout.\nconst ownerKinds = {\n  'issues.syncIssueList': 'issue_list',\n  'task-runs.pollTaskRuns': 'task_run_list',\n  'task-runs.syncThreadList': 'thread_list',\n  'coordinator.pollBotChatSummaries': 'bot_chat_list',\n} as const\nexport function plannedOwnerKinds(names: readonly BatchReadAction[]) {\n  return [...new Set(names.flatMap(name => name in ownerKinds ? [ownerKinds[name as keyof typeof ownerKinds]] : []))]\n}\n`
    if (variant === 'prototype' && path === 'lib/desktop-rpc/read-batch-context.ts') {
      text = once(text, "import { isLiveRevisionKind, LIVE_ID } from '../live/events'", "import { isLiveRevisionKind, LIVE_ID, type LiveKind } from '../live/events'")
      text = once(text, '  active: boolean\n', '  active: boolean\n  ownerRevisionKinds: readonly LiveKind[]\n')
      text = once(text, 'withReadBatchContext<T>(work: () => Promise<T>)', 'withReadBatchContext<T>(work: () => Promise<T>, ownerRevisionKinds: readonly LiveKind[] = [])')
      text = once(text, '{ active: true, owners: new Map(), revisions: new Map() }', '{ active: true, owners: new Map(), revisions: new Map(), ownerRevisionKinds }')
      text += `\n/** Probe-only: the scope is the original owner reader's already resolved home. */\nexport function plannedReadBatchOwnerRefs(scope: LiveScope): LiveRef[] {\n  const batch = batches.getStore()\n  return batch?.active ? batch.ownerRevisionKinds.map(kind => ({ kind, id: scope.workspaceId })) : []\n}\n`
    }
    if (variant === 'prototype' && path === 'lib/desktop-rpc/read-batch.ts') {
      text = once(text, 'import { isBatchReadAction, MAX_READ_BATCH,', 'import { plannedOwnerKinds, isBatchReadAction, MAX_READ_BATCH,')
      text = once(text, '      return items\n    })', '      return items\n    }, plannedOwnerKinds(prepared.map(item => item.name)))')
    }
    if (variant === 'prototype' && path === 'lib/live/revision-read.ts') {
      text = once(text, "import { readBatchRevisions } from '../desktop-rpc/read-batch-context'", "import { plannedReadBatchOwnerRefs, readBatchRevisions } from '../desktop-rpc/read-batch-context'\nimport { liveRevisionKey } from './revisions'")
      text = once(text, '  return { scope, revisions: await readRevisions([...scope ? kinds.map(kind => ({ kind, id: scope.workspaceId })) : [], ...others]) }',
        `  const refs = [...scope ? kinds.map(kind => ({ kind, id: scope.workspaceId })) : [], ...others]\n  const requested = new Set(refs.map(ref => liveRevisionKey(ref.kind, ref.id.toLowerCase())))\n  const revisions = await readRevisions([...refs, ...scope ? plannedReadBatchOwnerRefs(scope) : []])\n  return { scope, revisions: Object.fromEntries(Object.entries(revisions).filter(([key]) => requested.has(key))) }`)
    }
    await module(variant, path, text)
  }
  await put(variant, 'fixture.mjs', await readFile(`${root}/fixture-template.mjs`, 'utf8'))
  await put(variant, 'lib/workspace-db.mjs', "export { workspacePool, workspaceDb } from '../fixture.mjs'\n")
  await put(variant, 'lib/db/request-scope.mjs', "export { pool } from '../../fixture.mjs'\n")
  await put(variant, 'lib/request-log.mjs', "export { withRpcActionLog } from '../fixture.mjs'\n")
  const taskImports = `import { createHash } from 'node:crypto'\nimport { beginOwnerListRead } from '../../lib/live/revision-read.mjs'\nimport { ownerListRead } from '../../lib/live/list-read-server.mjs'\nimport { cacheReadAction } from '../../lib/cache-read-action.mjs'\nimport { ActionFailureError } from '../../lib/action-error.mjs'\nimport { changedListIds, listPositionKey, readListPositions, unchangedList } from '../../lib/list-poll.mjs'\nimport { singleFlight, readCompactRunFailure, runFailureBrief, DEVICE_ONLINE_WINDOW_MS, isDeviceOnline, headers, and, desc, eq, inArray, isNotNull, sql, deviceOnlineStates, gatewayConfig, auth, db, agents, agentRuns, bots, devices, issues, runAgentName, runBotId, runBotName, runTaskPrompt, replyLine, queryVersionWithExpiry, withDatabaseOperation, withDevicePresence, issueShortTitle } from '../../fixture.mjs'`
  await module(variant, 'app/actions/task-runs.ts', await extracted('app/actions/task-runs.ts', ['pollTaskRuns', 'readTaskRuns', 'pollThreads', 'syncThreadList', 'readThreads'], taskImports))
  const coordinatorImports = `import { withDatabaseOperation, auth, headers, chatStore } from '../../fixture.mjs'\nimport { ActionFailureError } from '../../lib/action-error.mjs'\nimport { beginOwnerListRead } from '../../lib/live/revision-read.mjs'\nimport { ownerListRead } from '../../lib/live/list-read-server.mjs'`
  await module(variant, 'app/actions/coordinator.ts', await extracted('app/actions/coordinator.ts', ['getUser', 'getUserId', 'pollBotChatSummaries', 'readBotChatSummaries'], coordinatorImports))
  const issuesImports = `import { createHash } from 'node:crypto'\nimport { beginOwnerListRead } from '../../lib/live/revision-read.mjs'\nimport { ownerListRead } from '../../lib/live/list-read-server.mjs'\nimport { cacheReadAction } from '../../lib/cache-read-action.mjs'\nimport { ActionFailureError } from '../../lib/action-error.mjs'\nimport { loadWorkspaceContext } from '../../lib/workspace-access.mjs'\nimport { changedListIds, listPositionKey, readListPositions, unchangedList } from '../../lib/list-poll.mjs'\nimport { currentUser, withDatabaseOperation, accessibleTeamScopes, queryVersion, workspaceDb, teamIssues, localTeams, or, eq, inArray, issueVisibility, db, issues, users, issueMembers, and, sql, desc, issueShortTitle, issueAttrsContent, issueChecklistTotal, issueChecklistChecked, issueTeamScope, singleFlight, actingContext, readIssueMetadata, taskIdentifiers, checklistView } from '../../fixture.mjs'`
  await module(variant, 'app/actions/issues.ts', await extracted('app/actions/issues.ts', ['getUserId', 'pollIssues', 'syncIssueList', 'readIssues', 'readIssueSnapshot'], issuesImports))
  const workspaceImports = `import { cache, tokenWorkspace, requireUser, getLocale, cookies, workspaceDb, workspaces, workspaceMembers, eq, and, asc, ensurePersonalShare, ensurePersonalWorkspace, renameGeneratedWorkspace, z } from '../fixture.mjs'\nimport { WorkspaceError } from './workspace-error.mjs'`
  await module(variant, 'lib/workspace-access.ts', await extracted('lib/workspace-access.ts', ['workspaceLocale', 'loadWorkspaceContext', 'readWorkspaceContext'], workspaceImports))
  manifest.variants[variant] = { changes: variant === 'baseline' ? 'No changes to copied product functions.' : 'Proposal only in independent copy: four closed action kinds, batch-local declaration, original-scope revision refs expansion, per-reader projection. readBatchRevisions itself unchanged.' }
}
await writeFile(`${root}/source-copy-manifest.safe.json`, JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify({ prepared: true, sourceFiles: manifest.sourceFiles.length, exactDeclarations: manifest.extraction.length, productCheckoutEdits: 0 }))
