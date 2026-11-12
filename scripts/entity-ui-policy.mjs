import path from 'node:path'
import ts from 'typescript'

// Public business operations, their authorized sources, and the detail components
// permitted to present them. "adapters" reuse an operation or represent it natively.
export const entityContracts = [
  { entity: 'Task', routes: [['apps/mobile/app/task/[id]/index.tsx', 'TaskScreen', '@/features/tasks/screens/task-screen']], detail: ['components/workspace/task-detail.tsx', 'TaskDetail'],
    sources: [['app/actions/issues.ts', 'pollIssue', 'saveIssue'], ['lib/task-presentation-read.ts', 'readTaskPresentations']],
    adapters: [['components/coordinator/conversation-panels.tsx', 'EmbeddedTaskDetail'], ['apps/mobile/features/tasks/screens/task-screen.tsx', 'TaskScreen']] },
  { entity: 'Thread', routes: [['apps/mobile/app/thread/[id].tsx', 'ThreadScreen']], detail: ['components/workspace/issue-thread-panel.tsx', 'IssueThreadPanel'],
    adapters: [['apps/mobile/app/thread/[id].tsx', 'ThreadScreen']],
    sources: [['app/actions/agents.ts', 'getIssueThread', 'sendIssueThreadReply', 'stopRun']] },
  { entity: 'Review diff', detail: ['components/workspace/thread-changes.tsx', 'ThreadChangesView'],
    sources: [['app/actions/agents.ts', 'getThreadChanges'], ['lib/thread-changes.ts', 'parseUnifiedDiff']] },
  { entity: 'Search', sources: [['lib/site-search.ts', 'siteSearchQuery', 'fetchSiteSearchPage']] },
  { entity: 'Project', detail: ['components/workspace/project-detail.tsx', 'ProjectDetail'],
    sources: [['components/workspace/use-project-update.ts', 'useProjectUpdate'], ['app/actions/projects.ts', 'listProjectEvents', 'updateProjectProperties']] },
  { entity: 'Connected app', detail: ['components/plugins/connected-apps.tsx', 'ConnectedAppDetail'],
    sources: [['components/plugins/connected-apps.tsx', 'useAppDetail']] },
  { entity: 'Artifact', routes: [['apps/mobile/app/artifact/[id].tsx', 'ArtifactScreen']], detail: ['components/artifacts/artifact-viewer.tsx', 'ArtifactViewer'],
    sources: [['app/actions/artifacts.ts', 'getArtifact', 'getArtifactText', 'shareArtifact', 'stopSharingArtifact']] },
  { entity: 'Bot conversation', routes: [['apps/mobile/app/bots/[id]/index.tsx', 'BotChat']],
    sources: [['apps/mobile/features/chat/screens/chat-screen.tsx', 'ChatScreen']] },
  { entity: 'Group conversation', routes: [['apps/mobile/app/groups/[id].tsx', 'GroupChat']],
    sources: [['lib/group-messages.ts', 'groupMessagesUrl', 'postGroupMessage']] },
  { entity: 'Bot name', detail: ['components/nav/bot-overview.tsx', 'BotOverviewBody'],
    sources: [['components/nav/use-save-bot.ts', 'useSaveBot'], ['app/actions/bots.ts', 'updateBot']] },
  { entity: 'Settings device', sources: [['components/devices/use-device-actions.ts', 'useDeviceActions'],
    ['app/actions/agents.ts', 'renameDevice', 'setDeviceEnabled', 'removeDevice', 'sendDeviceCommand']] },
  // These are cross-entry read and submission-state owners. Layouts may differ,
  // but must not fork the Inbox count, Factory question or composer state machine.
  { entity: 'Inbox and Factory questions',
    sources: [['hooks/use-inbox-count.ts', 'useInboxCount'],
      ['hooks/use-factory-questions.ts', 'factoryQuestionsVersion', 'useFactoryQuestions']] },
  { entity: 'Chat composer', sources: [['hooks/use-chat-composer.ts', 'useChatComposer']] },
]

const taskDetail = entityContracts[0].detail[0]
const registered = new Set(entityContracts.flatMap(contract => [contract.detail, ...(contract.adapters ?? [])]
  .filter(Boolean).map(([file, name]) => file + '#' + name)))
const detailName = /^[A-Z][A-Za-z0-9]*Detail(?:Page|Panel|Screen)?$/
const taskController = /^(?:(?:use)?(?:Task|Issue)(?:Detail|Panel)Controller|TaskPanel|TaskForm)$/
// Guard the named shared state-machine owners as well as the details above.
// Native clients deliberately keep their own UI adapters and are excluded.
const sharedHookOwners = new Map([
  ['useInboxCount', 'hooks/use-inbox-count.ts'],
  ['factoryQuestionsVersion', 'hooks/use-factory-questions.ts'],
  ['useFactoryQuestions', 'hooks/use-factory-questions.ts'],
  ['useChatComposer', 'hooks/use-chat-composer.ts'],
])
const nativeDetailPath = /^apps\/mobile\/app\/(?:[^/]+\/)*\[[^/]+\](?:\/index)?\.tsx$/
const nativeRoutes = new Map(entityContracts.flatMap(contract => (contract.routes ?? []).map(route => [route[0], route])))

const sourceFile = (file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const exported = node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)

// Only top-level component declarations count; a DTO type, comment, or private
// helper inside the existing editor is not a new business detail entry point.
function declarations(source) {
  const names = []
  for (const node of source.statements) {
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      if (node.name) names.push({ name: node.name.text, node, exported: exported(node) })
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const item of node.exportClause.elements) if (!item.isTypeOnly)
        names.push({ name: item.name.text, node: item, exported: true })
    } else if (ts.isVariableStatement(node)) {
      for (const item of node.declarationList.declarations) if (ts.isIdentifier(item.name))
        names.push({ name: item.name.text, node: item, exported: exported(node) })
    }
  }
  return names
}

function auditNativeRoute(file, text) {
  const route = nativeRoutes.get(file)
  const missing = { file, line: 1, column: 1, rule: 'entity/native-detail-route',
    message: 'Register this native detail route and its implementation in the entity contract.' }
  if (!route) return [missing]
  const [, name, module] = route
  const source = sourceFile(file, text)
  const matches = source.statements.some(node => {
    if (!module) return ts.isFunctionDeclaration(node) && node.name?.text === name && exported(node) &&
      node.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)
    if (!ts.isExportDeclaration(node) || node.isTypeOnly || node.moduleSpecifier?.text !== module ||
      !node.exportClause || !ts.isNamedExports(node.exportClause)) return false
    return node.exportClause.elements.some(binding => !binding.isTypeOnly && binding.name.text === 'default' && binding.propertyName?.text === name)
  })
  return matches ? [] : [missing]
}

export function auditEntityDetail(file, text) {
  if (/\.(?:test|spec|stories)\./.test(file)) return []
  if (nativeDetailPath.test(file)) return auditNativeRoute(file, text)
  if (!/^(?:components|hooks|lib|apps\/mobile\/(?:features|app)|apps\/desktop\/src\/renderer)\//.test(file)
    || !/(?:Detail|TaskPanel|TaskForm|PanelController|useInboxCount|factoryQuestionsVersion|useFactoryQuestions|useChatComposer)/.test(text)) return []
  const source = sourceFile(file, text)
  const violations = []
  for (const entry of declarations(source)) {
    const duplicate = taskController.test(entry.name) && file !== taskDetail
    const unregistered = !file.startsWith('lib/') && entry.exported && detailName.test(entry.name) && !registered.has(file + '#' + entry.name)
    const duplicateSharedHook = !file.startsWith('apps/mobile/') &&
      sharedHookOwners.has(entry.name) && sharedHookOwners.get(entry.name) !== file
    if (!duplicate && !unregistered && !duplicateSharedHook) continue
    const position = source.getLineAndCharacterOfPosition(entry.node.getStart(source))
    violations.push({ file, line: position.line + 1, column: position.character + 1,
      rule: duplicateSharedHook ? 'entity/shared-hook-owner' : 'entity/detail-source',
      message: duplicateSharedHook
        ? `${entry.name} must use the registered shared hook in ${sharedHookOwners.get(entry.name)}.`
        : `${entry.name} must use a registered canonical business operation or its compact/native adapter.` })
  }
  return violations
}

export function verifyEntityContracts(read) {
  const diagnostics = []
  for (const contract of entityContracts) {
    for (const [file] of contract.routes ?? []) if (read(file) === undefined) diagnostics.push({ file, line: 1, column: 1,
      rule: 'entity/native-detail-route', message: `${contract.entity} requires its registered native detail route.` })
    for (const [file, ...names] of [contract.detail, ...(contract.adapters ?? []), ...contract.sources].filter(Boolean)) {
      const text = read(file)
      const actual = new Set(text === undefined ? [] : declarations(sourceFile(file, text)).filter(item => item.exported).map(item => item.name))
      for (const name of names) if (!actual.has(name)) diagnostics.push({ file, line: 1, column: 1,
        rule: 'entity/contract-export', message: `${contract.entity} requires the declared export ${name}.` })
    }
  }
  return diagnostics
}

const taskEntries = new Set([
  'components/workspace/issue-workspace.tsx',
  'components/coordinator/conversation-panels.tsx',
])

function visit(node, callback) {
  callback(node)
  ts.forEachChild(node, child => visit(child, callback))
}

function importsTaskDetail(file, specifier) {
  const module = specifier.startsWith('.') ? path.posix.join(path.posix.dirname(file), specifier) : specifier.replace(/^@\//, '')
  return module.replace(/\.tsx?$/, '') === taskDetail.replace(/\.tsx$/, '')
}

// A workspace/side panel may navigate or load its tab label. Its component that
// actually renders the editor must resolve to the same TaskDetail module.
export function auditTaskEntry(file, text) {
  if (!taskEntries.has(file)) return []
  const source = sourceFile(file, text)
  const bindings = new Set()
  const rendered = new Set()
  const diagnostics = []
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const names = statement.importClause?.namedBindings
      if (!names || !ts.isNamedImports(names) || statement.importClause.isTypeOnly) continue
      for (const binding of names.elements) {
        const symbol = (binding.propertyName ?? binding.name).text
        if (binding.isTypeOnly) continue
        if (symbol === 'TaskDetail' && importsTaskDetail(file, statement.moduleSpecifier.text)) bindings.add(binding.name.text)
        if (['pollIssue', 'saveIssue'].includes(symbol) && statement.moduleSpecifier.text.endsWith('/actions/issues')) {
          const { line, character } = source.getLineAndCharacterOfPosition(binding.getStart(source))
          diagnostics.push({ file, line: line + 1, column: character + 1, rule: 'entity/task-editor-command',
            message: 'The TaskDetail editor owns the full issue read and write. Open it with the task ID.' })
        }
      }
    }
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!declaration.initializer || !ts.isIdentifier(declaration.name)) continue
      let canonical = false, selectsDetail = false
      visit(declaration.initializer, node => {
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          ts.isStringLiteral(node.arguments[0]) && importsTaskDetail(file, node.arguments[0].text)) canonical = true
        if (ts.isPropertyAccessExpression(node) && node.name.text === 'TaskDetail') selectsDetail = true
      })
      if (canonical && selectsDetail) bindings.add(declaration.name.text)
    }
  }
  visit(source, node => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName)) rendered.add(node.tagName.text)
  })
  if (![...bindings].some(name => rendered.has(name))) diagnostics.push({ file, line: 1, column: 1, rule: 'entity/task-editor-entry',
    message: 'This task entry must render the canonical TaskDetail component.' })
  return diagnostics
}
