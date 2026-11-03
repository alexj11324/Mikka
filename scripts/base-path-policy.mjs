import ts from 'typescript'

/** Next's Link/router/redirect add the deployment prefix themselves. */
export function auditBasePath(file, source) {
  const ast = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const links = new Set(),
    redirects = new Set(),
    routerHooks = new Set(),
    helpers = new Set(),
    prefixes = new Set()
  const scopes = new Map()
  const scopeNode = (node) => ts.isSourceFile(node) || ts.isBlock(node) || ts.isFunctionLike(node)
  function scopeOf(node) {
    for (let at = node.parent; at; at = at.parent) if (scopeNode(at)) return at
    return ast
  }
  function bind(node, name, value) {
    const scope = scopeOf(node)
    if (!scopes.has(scope)) scopes.set(scope, new Map())
    scopes.get(scope).set(name, value)
  }
  function collect(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const module = node.moduleSpecifier.text,
        clause = node.importClause
      if (module === 'next/link' && clause?.name) links.add(clause.name.text)
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
        for (const element of clause.namedBindings.elements) {
          const name = element.name.text,
            imported = element.propertyName?.text ?? name
          if (/^(?:next\/(?:link|navigation|router)|(?:@\/)?i18n\/navigation)$/.test(module)) {
            if (imported === 'Link' || (imported === 'default' && module === 'next/link')) links.add(name)
            if (imported === 'redirect' || imported === 'permanentRedirect') redirects.add(name)
            if (imported === 'useRouter') routerHooks.add(name)
          }
          if (/(?:^|\/)base-path$/.test(module)) {
            if (imported === 'withBasePath') helpers.add(name)
            if (imported === 'BASE_PATH') prefixes.add(name)
          }
        }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
      bind(node, node.name.text, node.initializer)
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) bind(node, node.name.text, undefined)
    ts.forEachChild(node, collect)
  }
  collect(ast)
  function valueOf(node) {
    for (let at = node.parent; at; at = at.parent) {
      const values = scopes.get(at)
      if (values?.has(node.text)) return values.get(node.text)
    }
  }
  function prefixed(node, seen = new Set()) {
    if (!node || seen.has(node)) return false
    seen = new Set(seen).add(node)
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node)
    )
      return prefixed(node.expression, seen)
    if (ts.isStringLiteralLike(node)) return /^\/mikka(?:[/?#]|$)/.test(node.text)
    if (ts.isIdentifier(node)) return prefixes.has(node.text) || prefixed(valueOf(node), seen)
    if (ts.isCallExpression(node))
      return ts.isIdentifier(node.expression) && helpers.has(node.expression.text)
    if (ts.isTemplateExpression(node))
      return (
        /^\/mikka(?:[/?#]|$)/.test(node.head.text) ||
        (!/^https?:\/\//.test(node.head.text) &&
          node.templateSpans.some((span) => prefixed(span.expression, seen)))
      )
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
      return prefixed(node.left, seen) || prefixed(node.right, seen)
    if (ts.isConditionalExpression(node))
      return prefixed(node.whenTrue, seen) || prefixed(node.whenFalse, seen)
    if (ts.isObjectLiteralExpression(node))
      return node.properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          property.name.getText(ast).replace(/['"]/g, '') === 'pathname' &&
          prefixed(property.initializer, seen),
      )
    return false
  }
  const diagnostics = []
  function report(node) {
    const pos = ast.getLineAndCharacterOfPosition(node.getStart())
    diagnostics.push({
      file,
      line: pos.line + 1,
      column: pos.character + 1,
      rule: 'navigation/double-base-path',
      message:
        'Next Link、router 和 redirect 会自动添加 /mikka；传入未加前缀的应用路径。withBasePath 仅用于 fetch、普通 href 或外部客户端。',
    })
  }
  function visit(node) {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      links.has(node.tagName.getText(ast))
    ) {
      for (const attribute of node.attributes.properties)
        if (ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === 'href' && attribute.initializer) {
          const value = ts.isJsxExpression(attribute.initializer)
            ? attribute.initializer.expression
            : attribute.initializer
          if (prefixed(value)) report(attribute)
        }
    }
    if (ts.isCallExpression(node) && prefixed(node.arguments[0])) {
      if (ts.isIdentifier(node.expression) && redirects.has(node.expression.text)) report(node)
      else if (
        ts.isPropertyAccessExpression(node.expression) &&
        ['push', 'replace', 'prefetch'].includes(node.expression.name.text) &&
        ts.isIdentifier(node.expression.expression)
      ) {
        const receiver = valueOf(node.expression.expression)
        if (
          receiver &&
          ts.isCallExpression(receiver) &&
          ts.isIdentifier(receiver.expression) &&
          routerHooks.has(receiver.expression.text)
        )
          report(node)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return diagnostics
}
