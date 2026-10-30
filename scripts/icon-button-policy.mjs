import ts from 'typescript'

/** Only report buttons whose visible children can be proved to be icons.
 * Unknown custom components/forwarded props are left to their own contracts. */
export function auditIconButtons(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.TSX)
  const icons = new Set(), buttons = new Set(['button', 'Button']), diagnostics = []
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) continue
    for (const spec of statement.importClause.namedBindings.elements) {
      if (statement.moduleSpecifier.text === 'lucide-react') icons.add(spec.name.text)
      if ((spec.propertyName?.text ?? spec.name.text) === 'Button') buttons.add(spec.name.text)
    }
  }
  const opening = n => ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : null
  const attr = (n, name) => n.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(source) === name)
  const value = a => a?.initializer && (ts.isJsxExpression(a.initializer) ? a.initializer.expression : a.initializer)
  function content(n) {
    if (ts.isJsxText(n)) return n.text.trim() ? 'text' : 'empty'
    if (ts.isJsxExpression(n)) return n.expression ? content(n.expression) : 'empty'
    if (ts.isParenthesizedExpression(n)) return content(n.expression)
    if (ts.isConditionalExpression(n)) {
      const branches = [content(n.whenTrue), content(n.whenFalse)]
      return branches.includes('unknown') ? 'unknown' : branches.includes('text') ? 'text' : branches.includes('icon') ? 'icon' : 'empty'
    }
    if (n.kind === ts.SyntaxKind.NullKeyword || n.kind === ts.SyntaxKind.FalseKeyword) return 'empty'
    if (ts.isStringLiteralLike(n)) return n.text.trim() ? 'text' : 'empty'
    const tag = opening(n)
    if (!tag) return 'unknown'
    const name = tag.tagName.getText(source)
    if (icons.has(name) || name === 'svg') return 'icon'
    if (name === 'span' && ts.isJsxElement(n)) return children(n.children)
    return 'unknown'
  }
  function children(nodes) {
    const kinds = nodes.map(content)
    return kinds.includes('unknown') ? 'unknown' : kinds.includes('text') ? 'text' : kinds.includes('icon') ? 'icon' : 'empty'
  }
  function visit(n) {
    if (ts.isJsxElement(n) && buttons.has(n.openingElement.tagName.getText(source))) {
      const tag = n.openingElement
      const label = value(attr(tag, 'aria-label'))
      const hasLabel = label && !(ts.isStringLiteralLike(label) && !label.text.trim()) && label.kind !== ts.SyntaxKind.NullKeyword && !(ts.isIdentifier(label) && label.text === 'undefined')
      // Spreads may forward a label supplied by a caller; do not guess its value.
      if (!hasLabel && !tag.attributes.properties.some(ts.isJsxSpreadAttribute) && children(n.children) === 'icon') {
        const { line, character } = source.getLineAndCharacterOfPosition(tag.getStart(source))
        diagnostics.push({ file, line: line + 1, column: character + 1, rule: 'accessibility/icon-button-label', message: '纯图标按钮必须提供 aria-label。' })
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(source)
  return diagnostics
}
