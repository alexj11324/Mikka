// #2869: model traffic leaves Mikka through the one LiteLLM client.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const client = 'lib/model-gateway/litellm-client.ts'
const roots = ['app/', 'apps/', 'lib/', 'packages/', 'cloudflare/', 'services/', 'workflows/']
const constructors = new Set(['createGateway', 'gateway', 'createOpenAI', 'createAnthropic', 'createOpenAICompatible'])
const modelDomain = /(?:api\.openai\.com|api\.anthropic\.com|ai-gateway\.vercel\.sh|api\.deepseek\.com|api\.moonshot\.(?:cn|ai)|zero\.cat|chatgpt\.com\/backend-api\/codex|api\.cloudflare\.com\/client\/v4\/accounts\/[^\s]*\/ai)/i

// Official subscription OAuth remains the explicit #2869 exception. Quota
// endpoints are account metadata; provider catalogue URLs are routing metadata
// passed to LiteLLM, never authorization to issue a direct model request.
const metadata = new Set(['lib/model-gateway/provider-config.ts', 'lib/model-admission/contract.ts', 'lib/audit/events.ts',
  'packages/daemon/src/quota/codex.ts', 'packages/daemon/src/quota/claude.ts'])

export function auditLiteLlmSource(file, source) {
  if (file === client) return []
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const found = []
  const report = (node, reason) => {
    const { line, character } = tree.getLineAndCharacterOfPosition(node.getStart(tree))
    found.push({ file, line: line + 1, column: character + 1, reason })
  }
  function visit(node) {
    // Reject provider imports too: renaming a factory cannot bypass the guard.
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const module = node.moduleSpecifier.text
      const subscription = file === 'lib/subscription-service.ts' && module === '@ai-sdk/openai-compatible'
      const bindings = node.importClause?.namedBindings
      const factory = bindings && ts.isNamedImports(bindings)
        && bindings.elements.some(item => constructors.has((item.propertyName ?? item.name).text))
      const providerModule = /^@ai-sdk\/(?:gateway|openai|anthropic|openai-compatible)$/.test(module)
      const runtimeImport = !node.importClause?.isTypeOnly && (node.importClause?.name
        || (bindings && ts.isNamespaceImport(bindings))
        || (bindings && ts.isNamedImports(bindings) && bindings.elements.some(item => !item.isTypeOnly && !(item.propertyName ?? item.name).text.endsWith('Error'))))
      if (!subscription && ((providerModule && runtimeImport) || (module === 'ai' && factory))) {
        report(node, 'provider SDK imports belong in the LiteLLM client')
      }
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
      && /^@ai-sdk\/(?:gateway|openai|anthropic|openai-compatible)$/.test(node.arguments[0].text)) {
      report(node, 'dynamic provider imports belong in the LiteLLM client')
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && constructors.has(node.expression.text)) {
      // The subscription worker supplies the transport; this placeholder URL
      // cannot reach a provider and preserves the approved OAuth exception.
      const subscription = file === 'lib/subscription-service.ts' && node.expression.text === 'createOpenAICompatible'
        && node.arguments[0]?.getText(tree).includes("baseURL: 'https://mikka.invalid/v1'")
      if (!subscription) report(node, 'model SDK construction belongs in the LiteLLM client')
    }
    if ((ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) && modelDomain.test(node.getText(tree)) && !metadata.has(file)) {
      report(node, 'provider model domains belong in LiteLLM configuration')
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return found
}

export function auditLiteLlmRepository() {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(file => roots.some(root => file.startsWith(root)) && /\.[cm]?[jt]sx?$/.test(file)
      && !/(?:^|\/)(?:node_modules|dist|build|out|__tests__|tests?|e2e|fakes|fixtures)\//.test(file)
      && !/\.(?:test|spec|fixture|stories|node-test)\.[cm]?[jt]sx?$/.test(file) && !file.endsWith('.d.ts') && existsSync(file))
    .flatMap(file => auditLiteLlmSource(file, readFileSync(file, 'utf8')))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const found = auditLiteLlmRepository()
  for (const item of found) console.error(`${item.file}:${item.line}:${item.column} [litellm-only] ${item.reason}`)
  process.exitCode = found.length ? 1 : 0
}
