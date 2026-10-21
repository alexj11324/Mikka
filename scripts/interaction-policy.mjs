import ts from 'typescript'

const actionControls = /^(?:button|Button|SidebarMenu(?:Sub)?Button|SidebarMenu(?:Sub)?Action|InputGroupButton|DropdownMenuItem|ContextMenuItem|MenubarItem|CommandItem|NavigationMenuLink)$/
const behaviorControls = /^(?:(?:Dialog|AlertDialog|Sheet|Drawer)(?:Trigger|Close|Cancel)|(?:DropdownMenu|ContextMenu|Menubar|Popover|HoverCard|Collapsible|Accordion|Select|Combobox|NavigationMenu)(?:Trigger|SubTrigger)|(?:Tabs|ToggleGroup|RadioGroup)(?:Trigger|Item)|Toggle|SidebarTrigger|SidebarRail|KanbanItemHandle)$/
const ignoredCalls = /^(?:console\.(?:log|info|debug|warn|error)|(?:[\w.]+\.)?(?:preventDefault|stopPropagation|stopImmediatePropagation))$/
const placeholderText = /(?:coming\s+soon|not\s+implemented|待实现|尚未实现|敬请期待|功能开发中)/i

export function auditInteractions(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.jsx?$/.test(file) ? ts.ScriptKind.JSX : ts.ScriptKind.TSX)
  const diagnostics = [], imports = new Map(), declarations = new Map(), forms = new Map()
  const opening = node => node && (ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null)
  const attr = (node, name) => node.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(source) === name)
  const expression = attribute => attribute?.initializer && (ts.isJsxExpression(attribute.initializer) ? attribute.initializer.expression : attribute.initializer)
  const literal = node => node && ts.isStringLiteralLike(node) ? node.text : undefined
  const nameOf = node => imports.get(node.tagName.getText(source)) ?? node.tagName.getText(source)
  const add = (node, rule, message) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source))
    diagnostics.push({ file, line: line + 1, column: character + 1, rule, message })
  }
  function index(node) {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const spec of node.importClause.namedBindings.elements) imports.set(spec.name.text, spec.propertyName?.text ?? spec.name.text)
    }
    if ((ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) || ts.isFunctionDeclaration(node) && node.name) {
      const entries = declarations.get(node.name.text) ?? []
      entries.push(node); declarations.set(node.name.text, entries)
    }
    const tag = opening(node)
    if (tag && nameOf(tag) === 'form') {
      const id = literal(expression(attr(tag, 'id')))
      if (id) forms.set(id, tag)
    }
    ts.forEachChild(node, index)
  }
  index(source)
  function binding(node) {
    const scopes = new Set()
    for (let p = node; p; p = p.parent) scopes.add(p)
    return (declarations.get(node.text) ?? []).findLast(entry => {
      let scope = entry.parent
      while (scope && !ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent
      return scopes.has(scope)
    })
  }
  function unwrap(node) {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node))) node = node.expression
    return node
  }
  function hasEffects(node, seen) {
    node = unwrap(node)
    if (!node || ts.isIdentifier(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isThrowStatement(node)) return false
    if (ts.isCallExpression(node)) return meaningful(node, seen)
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return meaningful(node, seen)
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) return true
    let result = false
    ts.forEachChild(node, child => { if (hasEffects(child, seen)) result = true })
    return result
  }
  function meaningful(node, seen = new Set()) {
    node = unwrap(node)
    if (!node) return false
    if (ts.isIdentifier(node)) {
      if (['undefined', 'null', 'false', 'true', 'NaN', 'noop', 'noOp'].includes(node.text)) return false
      const entry = binding(node)
      if (!entry) return true
      if (seen.has(entry)) return false
      return ts.isFunctionDeclaration(entry) ? hasEffects(entry.body, new Set([...seen, entry])) : meaningful(entry.initializer, new Set([...seen, entry]))
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return hasEffects(node.body, seen)
    if (ts.isCallExpression(node)) {
      const call = node.expression.getText(source)
      if (ignoredCalls.test(call) || /^Promise\.(?:resolve|reject)$/.test(call) && !node.arguments.some(arg => hasEffects(arg, seen))) return false
      if (node.arguments.some(arg => ts.isStringLiteralLike(arg) && placeholderText.test(arg.text))) return false
      if (ts.isIdentifier(node.expression) && binding(node.expression)) return meaningful(node.expression, seen)
      return true
    }
    if (ts.isConditionalExpression(node)) return meaningful(node.whenTrue, seen) || meaningful(node.whenFalse, seen)
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        const entry = binding(node.expression)
        const value = unwrap(entry?.initializer)
        const key = ts.isPropertyAccessExpression(node) ? node.name.text : literal(node.argumentExpression)
        if (value && ts.isObjectLiteralExpression(value) && key) {
          const property = value.properties.find(prop => prop.name && (ts.isIdentifier(prop.name) ? prop.name.text : literal(prop.name)) === key)
          if (property && ts.isPropertyAssignment(property)) return meaningful(property.initializer, seen)
          if (property && ts.isMethodDeclaration(property)) return meaningful(property.body, seen)
        }
      }
      return true
    }
    if (ts.isThrowStatement(node)) return false
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return !/^\w+\.(?:returnValue|cancelBubble)$/.test(node.left.getText(source))
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      if ([ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) return true
    }
    if (ts.isReturnStatement(node) || ts.isAwaitExpression(node) || ts.isVoidExpression(node)) return meaningful(node.expression, seen)
    if (ts.isIfStatement(node)) return meaningful(node.thenStatement, seen) || meaningful(node.elseStatement, seen)
    if (ts.isBinaryExpression(node)) return meaningful(node.left, seen) || meaningful(node.right, seen)
    if (ts.isBlock(node) || ts.isExpressionStatement(node) || ts.isTryStatement(node) || ts.isVariableStatement(node) || ts.isVariableDeclarationList(node) || ts.isVariableDeclaration(node)) {
      let result = false
      ts.forEachChild(node, child => { if (meaningful(child, seen)) result = true })
      return result
    }
    return false
  }
  function surrounding(node) {
    const parents = []
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isJsxElement(p) && p.openingElement !== node) parents.push(p.openingElement)
      if (ts.isJsxAttribute(p) && ['render', 'asChild'].includes(p.name.getText(source)) && opening(p.parent?.parent)) parents.push(opening(p.parent.parent))
    }
    return [...new Set(parents)]
  }
  function hasAction(node) {
    return ['onClick', ...(nameOf(node) === 'CommandItem' ? ['onSelect'] : [])].some(key => meaningful(expression(attr(node, key))))
  }
  function realHref(node) {
    const href = expression(attr(node, 'href'))
    function valid(value) {
      value = unwrap(value)
      if (value && ts.isConditionalExpression(value)) return valid(value.whenTrue) && valid(value.whenFalse)
      if (value && ts.isIdentifier(value)) {
        const entry = binding(value)
        if (entry?.initializer && ts.isStringLiteralLike(unwrap(entry.initializer))) return valid(entry.initializer)
      }
      if (value && ts.isTemplateExpression(value)) return true
      const target = literal(value)
      if (target !== undefined) return !!target.trim() && target.trim() !== '#' && !/^javascript:/i.test(target.trim())
      return meaningful(value)
    }
    return valid(href)
  }
  function renderedNavigation(node) {
    const host = opening(unwrap(expression(attr(node, 'render'))))
    return !!host && (realHref(host) || hasAction(host))
  }
  function visit(node) {
    const tag = opening(node)
    if (tag) {
      const name = nameOf(tag), parents = surrounding(tag)
      const role = literal(expression(attr(tag, 'role')))
      const isAction = actionControls.test(name) || ['button', 'menuitem', 'link'].includes(role) || ['a', 'Link'].includes(name)
      if (isAction) {
        const handlers = ['onClick', 'onSelect'].map(key => attr(tag, key)).filter(Boolean)
        for (const handler of handlers) if (!meaningful(expression(handler))) add(handler, 'interaction/no-placeholder-action', '按钮动作为空、仅日志/拦截事件或占位提示；必须接入实际功能。')
        const type = literal(expression(attr(tag, 'type')))
        const formId = literal(expression(attr(tag, 'form')))
        const form = formId ? forms.get(formId) : parents.find(parent => nameOf(parent) === 'form')
        const submit = type === 'submit' || name === 'button' && !type && !!form
        const formAction = submit && (meaningful(expression(attr(tag, 'formAction'))) || !!form && ['onSubmit', 'action'].some(key => meaningful(expression(attr(form, key)))))
        const renderParent = tag.parent && ts.isJsxExpression(tag.parent) && ts.isJsxAttribute(tag.parent.parent) && tag.parent.parent.name.getText(source) === 'render' ? tag.parent.parent.parent.parent : null
        const composed = !!renderParent && hasAction(renderParent) || parents.some(parent => behaviorControls.test(nameOf(parent)) || nameOf(parent) === 'Slot' && hasAction(parent))
        const navigation = realHref(tag) || renderedNavigation(tag)
        if (!hasAction(tag) && !behaviorControls.test(name) && !composed && !formAction && !(type === 'reset' && form) && !navigation) {
          add(tag, 'interaction/no-dead-control', '可点击控件没有实际事件、有效导航、表单动作或组件触发行为；不能用 disabled、Tooltip 或空回调代替功能。')
        }
        const href = expression(attr(tag, 'href'))
        if (href && literal(href) !== undefined && !realHref(tag) && !hasAction(tag)) add(tag, 'interaction/no-placeholder-link', '链接目标为空、# 或 javascript 占位；请接入真实地址或动作。')
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return diagnostics
}
