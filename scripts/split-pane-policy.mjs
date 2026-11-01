import ts from 'typescript'

// Every vertical line between two columns can be dragged to resize them
// (decision 2026-11-01-1300, R-35). A column that draws its own side border
// and keeps a fixed width beside another column is exactly such a line, so it
// must be a <ResizablePane>, or render a <ResizeHandle> inside it. A line that
// is not between columns (a loading skeleton, a timeline rule) says so with a
// `split-pane-exempt: <reason>` comment on its line or the line above.

const BORDER = /^border-(?:l|r|s|e|x)$/
const FIXED = /^(?:w-(?:\d|\[|\()|basis-|shrink-0$)/
const EXEMPT = /split-pane-exempt:\s*\S/

/** The utility classes a className expression names, from every string in it, without variants. */
function classes(expression) {
  const found = []
  const visit = node => {
    if (ts.isStringLiteralLike(node)) found.push(...node.text.split(/\s+/).filter(Boolean).map(name => name.split(':').at(-1)))
    ts.forEachChild(node, visit)
  }
  visit(expression)
  return found
}

export function auditSplitPanes(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.TSX)
  const lines = text.split('\n')
  const diagnostics = []
  const tagName = node => (ts.isJsxElement(node) ? node.openingElement : node).tagName.getText(source)
  const hasHandle = node => {
    let found = false
    const visit = child => {
      if (found) return
      if ((ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) && ['ResizeHandle', 'ResizablePane'].includes(tagName(child))) { found = true; return }
      ts.forEachChild(child, visit)
    }
    ts.forEachChild(node, visit)
    return found
  }
  const visit = node => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node
      const className = opening.attributes.properties.find(prop => ts.isJsxAttribute(prop) && prop.name.getText(source) === 'className')
      const value = className?.initializer && (ts.isJsxExpression(className.initializer) ? className.initializer.expression : className.initializer)
      if (value && tagName(node) !== 'ResizablePane') {
        const names = classes(value)
        if (names.some(name => BORDER.test(name)) && names.some(name => FIXED.test(name)) && !hasHandle(node)) {
          const { line, character } = source.getLineAndCharacterOfPosition(opening.getStart(source))
          if (!EXEMPT.test(lines[line] ?? '') && !EXEMPT.test(lines[line - 1] ?? '')) diagnostics.push({
            file, line: line + 1, column: character + 1, rule: 'layout/resizable-divider',
            message: '分栏竖线必须能拖动调宽：改用 <ResizablePane>（components/ui/resizable-pane.tsx），或在栏内放 <ResizeHandle>；不是分栏的线用 `split-pane-exempt: 原因` 注释说明。',
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return diagnostics
}
