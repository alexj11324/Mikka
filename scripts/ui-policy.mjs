import ts from 'typescript'
import postcss from 'postcss'

export function isComponentLibrarySource(file, policy) {
  return policy.componentRoots.some(root => file.startsWith(root))
}

export function splitUtilities(value) {
  const tokens = []
  let token = '', depth = 0, quote = ''
  for (const char of value) {
    if (quote) { if (char === quote) quote = ''; token += char; continue }
    if (depth && (char === '"' || char === "'")) { quote = char; token += char; continue }
    if (char === '[' || char === '(') depth++
    if (char === ']' || char === ')') depth--
    if (/\s/.test(char) && depth === 0) { if (token) tokens.push(token); token = '' }
    else token += char
  }
  if (token) tokens.push(token)
  return tokens
}

export function utilityBase(token) {
  let depth = 0, start = 0
  for (let i = 0; i < token.length; i++) {
    if ('[('.includes(token[i])) depth++
    if ('])'.includes(token[i])) depth--
    if (token[i] === ':' && depth === 0) start = i + 1
  }
  return token.slice(start).replace(/^!|!$/g, '')
}

const palette = /^(?:bg|text|border(?:-[trblxyse])?|ring|outline|fill|stroke|decoration|from|via|to|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white)(?:-|\/|$)/
// 组件库里有对应成品组件的原生元素。手写它们等于重复实现一份组件。
// 判据来自 shadcn 官方 skills 文档：Use existing components before custom markup.
const RAW_ELEMENTS = {
  button: 'Button',
  input: 'Input / InputGroup',
  select: 'Select / NativeSelect',
  textarea: 'Textarea',
  dialog: 'Dialog / AlertDialog',
  table: 'Table',
  kbd: 'Kbd',
  nav: 'Sidebar / Breadcrumb / NavigationMenu',
  label: 'Label / FieldLabel',
  hr: 'Separator',
  progress: 'Progress',
  details: 'Collapsible / Accordion',
  summary: 'Collapsible / Accordion',
  fieldset: 'FieldSet',
}
const groupRules = new Map([
  ['SelectItem', 'SelectGroup'], ['SelectLabel', 'SelectGroup'],
  ['DropdownMenuItem', 'DropdownMenuGroup'], ['DropdownMenuLabel', 'DropdownMenuGroup'], ['DropdownMenuSub', 'DropdownMenuGroup'],
  ['ContextMenuItem', 'ContextMenuGroup'], ['MenubarItem', 'MenubarGroup'], ['CommandItem', 'CommandGroup'],
  ['TabsTrigger', 'TabsList'], ['MessageScrollerItem', 'MessageScrollerContent'],
])
const overlays = /^(?:Dialog|AlertDialog|Sheet|Drawer|DropdownMenu|ContextMenu|Menubar|Popover|Tooltip|HoverCard).*(?:Content|Overlay)$/

function checkUtility(token, policy, report) {
  const base = utilityBase(token)
  const arbitraryTextColor = /^text-(?:\[(?:color:|#|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix)\(|(?:Canvas|CanvasText|LinkText|VisitedText|ActiveText|ButtonFace|ButtonText|ButtonBorder|Field|FieldText|Highlight|HighlightText|SelectedItem|SelectedItemText|Mark|MarkText|GrayText|AccentColor|AccentColorText|transparent|currentColor)\])|\(color:)/i.test(base)
  if ((/^text-(?:\[|\()/.test(base) && !arbitraryTextColor) || /^(?:font|leading|tracking)-(?:\[|\()/.test(base) || /^\[(?:font|line-height|letter-spacing)/.test(base)) {
    report('typography/preset-only', `非预设排版值 ${token}；使用 ui-policy.json 中的档位。`)
  } else if (/^text-(?:\d+(?:\.\d+)?(?:px|rem|em)|\d+xl)/.test(base) && !policy.typography.sizes.includes(base.slice(5).split('/')[0])) {
    report('typography/preset-only', `未批准的字号 ${token}。`)
  } else {
    for (const [prefix, values] of [['font-', [...policy.typography.weights, ...policy.typography.families]], ['leading-', policy.typography.leading], ['tracking-', policy.typography.tracking]]) {
      if (base.startsWith(prefix) && !values.includes(base.slice(prefix.length))) report('typography/preset-only', `未批准的排版档位 ${token}。`)
    }
    const slash = base.match(/^text-(xs|sm|base|lg|xl|\d+xl)\/(.+)$/)
    if (slash && !policy.typography.leading.includes(slash[2])) report('typography/preset-only', `未批准的行高 ${token}。`)
  }
  // 用户偏好无分割线：全宽水平长线一律用留白 / 背景分组替代。
  // 竖线（border-l/r、orientation="vertical"）不在此列；0 宽与 transparent 不构成可见线。
  const horizontalBorder = base.match(/^border-([tby])(?:-(.+))?$/)
  if (horizontalBorder && !['0', '0px', '[0px]', 'transparent', '[transparent]'].includes(horizontalBorder[2])) report('style/no-horizontal-rule', `禁止全宽水平长线 ${token}；用间距或背景分组。`)
  const divide = base.match(/^divide-y(?:-(.+))?$/)
  if (divide && !['0', 'reverse'].includes(divide[1])) report('style/no-horizontal-rule', `禁止全宽水平长线 ${token}；用间距或背景分组。`)
  if (palette.test(base) || arbitraryTextColor || /^(?:bg|border|ring|fill|stroke|outline)-(?:\[|\()/.test(base)) report('style/semantic-colors', `颜色必须使用语义 token：${token}。`)
  if (/^space-[xy]-/.test(base)) report('style/gap', `使用 flex/grid + gap，不使用 ${token}。`)
  if (/(?:^|:)dark:/.test(token) && /^(?:bg|text|border|ring|fill|stroke|outline)-/.test(base) && !base.endsWith('-transparent')) report('style/no-dark-color-override', `用语义 token 处理明暗主题，不单独覆盖 ${token}。`)
}

export function auditSource(file, text, policy) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.jsx?$/.test(file) ? ts.ScriptKind.JSX : ts.ScriptKind.TSX)
  const diagnostics = [], imports = new Map(), variables = new Map(), seen = new Set()
  const add = (node, rule, message) => {
    const start = node.getStart(source)
    const key = `${start}:${rule}:${message}`
    if (seen.has(key)) return
    seen.add(key)
    const { line, character } = source.getLineAndCharacterOfPosition(start)
    diagnostics.push({ file, line: line + 1, column: character + 1, rule, message })
  }
  function index(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const from = node.moduleSpecifier.text, clause = node.importClause
      if (clause?.name) imports.set(clause.name.text, { from, name: 'default' })
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const spec of clause.namedBindings.elements) imports.set(spec.name.text, { from, name: spec.propertyName?.text ?? spec.name.text })
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) imports.set(clause.namedBindings.name.text, { from, name: '*' })
      if (from === 'next/font/google') for (const spec of clause?.namedBindings?.elements ?? []) {
        const name = spec.propertyName?.text ?? spec.name.text
        if (!policy.typography.googleFonts.includes(name)) add(spec, 'typography/font-family', `字体 ${name} 不在批准的字体集合中。`)
      }
      if (from === 'next/font/local') add(node, 'typography/font-family', '本地字体也必须先进入统一字体策略，不允许临时引入。')
      if (/^(?:@base-ui\/|@radix-ui\/|radix-ui$|react\/jsx-runtime|react\/jsx-dev-runtime)/.test(from)) add(node, 'components/no-primitive-bypass', '业务代码只组合已下载组件，不直接使用底层 primitives 或 JSX runtime。')
      if (/^(?:@tabler\/icons|@heroicons\/|react-icons\/|@phosphor-icons\/)/.test(from) && from !== policy.iconLibrary) add(node, 'icons/library', `仅使用配置的 ${policy.iconLibrary}。`)
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const entries = variables.get(node.name.text) ?? []
      entries.push(node)
      variables.set(node.name.text, entries)
    }
    ts.forEachChild(node, index)
  }
  index(source)
  function binding(identifier) {
    const entries = variables.get(identifier.text) ?? []
    const scopes = []
    for (let p = identifier; p; p = p.parent) scopes.push(p)
    return entries.findLast(entry => {
      let scope = entry.parent
      while (scope && !ts.isSourceFile(scope) && !ts.isBlock(scope)) scope = scope.parent
      return scopes.includes(scope)
    })
  }
  function resolve(node, visited = new Set()) {
    if (!node) return { strings: [], known: true }
    if (ts.isStringLiteralLike(node)) return { strings: [node.text], known: true }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return resolve(node.expression, visited)
    if (ts.isIdentifier(node)) {
      if (['undefined', 'false', 'true'].includes(node.text)) return { strings: [], known: true }
      const entry = binding(node)
      // import 进来的常量在源文件里是静态字面量，本地追踪不到，但不该判成「不可检查」。
      if (!entry) return { strings: [], known: imports.has(node.text) }
      if (visited.has(entry)) return { strings: [], known: false }
      return resolve(entry.initializer, new Set([...visited, entry]))
    }
    if (node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.TrueKeyword) return { strings: [], known: true }
    const merge = nodes => {
      const values = nodes.map(n => resolve(n, new Set(visited)))
      return { strings: values.flatMap(v => v.strings), known: values.every(v => v.known) }
    }
    // 静态映射表的索引访问（如 RICH_TEXT_MARKUP_VIEW[markup]）：值在源文件里是静态的。
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && imports.has(node.expression.text)) return { strings: [], known: true }
    if (ts.isConditionalExpression(node)) return merge([node.whenTrue, node.whenFalse])
    if (ts.isBinaryExpression(node)) return merge(node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? [node.right] : [node.left, node.right])
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && imports.get(node.expression.text)?.name === 'cn' && ['cn', '@/lib/utils'].includes(imports.get(node.expression.text)?.from)) return merge(node.arguments)
    if (ts.isObjectLiteralExpression(node)) {
      return { strings: node.properties.filter(ts.isPropertyAssignment).flatMap(prop => ts.isStringLiteralLike(prop.name) ? [prop.name.text] : []), known: node.properties.every(prop => ts.isPropertyAssignment(prop) && !ts.isComputedPropertyName(prop.name)) }
    }
    return { strings: [], known: false }
  }
  const canonical = node => {
    if (!node) return ''
    const raw = node.tagName?.getText(source) ?? ''
    const entry = imports.get(raw)
    return entry && (entry.from.startsWith('@/components/') || entry.from.startsWith('.')) ? entry.name === 'default' ? raw : entry.name : raw
  }
  const opening = node => ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null
  const attrs = node => node.attributes.properties.filter(ts.isJsxAttribute)
  const attr = (node, name) => attrs(node).find(a => a.name.getText(source) === name)
  const ancestors = node => {
    const list = []
    for (let p = node.parent; p; p = p.parent) if (ts.isJsxElement(p) && p.openingElement !== node) list.push(canonical(p.openingElement))
    return list
  }
  const contains = (node, wanted) => {
    let found = false
    const visit = n => { const o = opening(n); if (o && canonical(o) === wanted) found = true; if (!found) ts.forEachChild(n, visit) }
    if (ts.isJsxElement(node.parent)) node.parent.children.forEach(visit)
    return found
  }
  function visit(node) {
    if (ts.isStringLiteralLike(node)) {
      for (const token of splitUtilities(node.text)) if (/^(?:text-|font-|leading-|tracking-|bg-|border-|divide-|ring-|outline-|fill-|stroke-|space-[xy]-|\[(?:font|line-height|letter-spacing))/.test(utilityBase(token))) checkUtility(token, policy, (rule, message) => add(node, rule, message))
    }
    if (ts.isPropertyAssignment(node) && /^(?:fontSize|fontFamily|fontWeight|lineHeight|letterSpacing|fontVariant|fontStyle)$/.test(node.name.getText(source).replaceAll(/['"]/g, ''))) add(node, 'typography/no-inline-values', '排版只能通过预设档位；不允许 style/配置对象手写字体值。')
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(source)
      const entry = imports.get(name)
      if (name === 'React.createElement' || entry?.name === 'createElement' || /(?:^|\.)(?:jsx|jsxs|jsxDEV)$/.test(name)) add(node, 'components/no-element-factory', '不允许通过 createElement/JSX runtime 绕过组件来源检查。')
      if (name === 'document.createElement' || entry?.name === 'cva') add(node, 'components/no-custom-implementation', '不允许在业务代码手写 UI 元素或 variants。')
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const raw = node.tagName.getText(source), name = canonical(node), parents = ancestors(node)
      const frameworkShell = ['app/layout.tsx', 'app/[locale]/layout.tsx'].includes(file) && ['html', 'body'].includes(raw)
      // Base UI 的 render prop 指定宿主元素（样式与行为由外层组件提供）：
      // 那里的自闭合标签是组合 API，不是手写的控件。
      const renderHost = ts.isJsxSelfClosingElement(node) && (() => {
        for (let p = node.parent; p; p = p.parent) {
          if (ts.isJsxAttribute(p)) return p.name.getText(source) === 'render'
          if (ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p)) return false
        }
        return false
      })()
      const replacement = RAW_ELEMENTS[raw]
      if (!frameworkShell && !renderHost && replacement) add(node, 'components/no-handwritten-ui', `手写 <${raw}>；改用 ${replacement}。`)
      if (ts.isIdentifier(node.tagName)) {
        const value = resolve(node.tagName)
        if (value.strings.some(tag => RAW_ELEMENTS[tag])) add(node, 'components/no-handwritten-ui', '不允许用大写变量包装 HTML 标签绕过限制。')
      }
      if ((attr(node, 'style') || attr(node, 'css') || attr(node, 'sx') || attr(node, 'dangerouslySetInnerHTML'))) add(node, 'style/no-inline-ui', '不允许 style/css/sx/HTML 字符串自绘 UI；使用组件预设。')
      const classAttr = attr(node, 'className')
      if (classAttr?.initializer) {
        const expression = ts.isJsxExpression(classAttr.initializer) ? classAttr.initializer.expression : classAttr.initializer
        const classes = resolve(expression)
        if (!frameworkShell && !classes.known) add(classAttr, 'style/static-layout-only', 'className 必须可静态检查，动态组合请使用 cn() 和明确的布局常量。')
        if (!frameworkShell && expression && (ts.isTemplateExpression(expression) || ts.isConditionalExpression(expression))) add(classAttr, 'style/use-cn', '条件 className 使用 cn()，不拼接模板或直接使用三元表达式。')
        for (const value of classes.strings) {
          const tokens = splitUtilities(value)
          if (tokens.includes('overflow-hidden') && tokens.includes('text-ellipsis') && tokens.includes('whitespace-nowrap')) add(classAttr, 'style/truncate', '使用 truncate 简写。')
          const bases = tokens.map(utilityBase)
          const drawnRule = bases.some(base => /^h-(?:px|0\.5)$/.test(base)) && bases.some(base => /^bg-(?!transparent|none$|clip-|origin-|cover|contain|center|left|right|top|bottom|repeat|no-repeat|fixed|local|scroll|auto|blend-)/.test(base))
          if (drawnRule) add(classAttr, 'style/no-horizontal-rule', '禁止用 h-px/0.5 + bg-* 手画水平细线；用间距或背景分组。')
          for (const token of tokens) {
            const base = utilityBase(token)
            // 组件调用处的视觉 class 不做限制。Orvilo 的规则集里没有这一条，
            // 而 shadcn 组件并不总提供对应 variant：硬禁只会逼出「包一层 span」的绕过，
            // 或者把设计意图直接删掉。原始色板另由 style/semantic-colors 拦截。
            if (overlays.test(name) && /^-?z-/.test(base)) add(classAttr, 'style/overlay-stacking', '浮层组件自行管理层叠，不指定 z-index。')
            if (base.startsWith('w-') && bases.includes(`h-${base.slice(2)}`)) add(classAttr, 'style/size-shorthand', `相同宽高使用 size-${base.slice(2)}。`)
          }
          const icon = imports.get(raw)?.from === policy.iconLibrary
          const hostEntry = imports.get(parents[0] ?? '')
          const hostIsLibrary = !!hostEntry && /^@\/components\/(?:ui|reui)\//.test(hostEntry.from)
          if (icon && hostIsLibrary && bases.some(b => /^(?:size|w|h)-/.test(b))) add(classAttr, 'icons/no-size-override', '组件内部的图标由组件决定尺寸。')
        }
      }
      const icon = imports.get(raw)?.from === policy.iconLibrary
      if (icon && parents.includes('Button') && !attr(node, 'data-icon')) add(node, 'icons/data-icon', 'Button 内图标必须设置 data-icon。')
      if (groupRules.has(name) && !parents.includes(groupRules.get(name))) add(node, 'composition/group', `${name} 必须位于 ${groupRules.get(name)} 内。`)
      if (['DialogContent', 'AlertDialogContent', 'SheetContent', 'DrawerContent'].includes(name) && !contains(node, name.replace('Content', 'Title'))) add(node, 'composition/title', `${name} 必须包含可访问的 Title（跨文件封装需人工核实）。`)
      if (name === 'Avatar' && !contains(node, 'AvatarFallback')) add(node, 'composition/avatar-fallback', 'Avatar 必须包含 AvatarFallback。')
      if (name === 'Separator') {
        const orientation = attr(node, 'orientation')
        const expression = orientation?.initializer && (ts.isJsxExpression(orientation.initializer) ? orientation.initializer.expression : orientation.initializer)
        const value = expression ? resolve(expression) : { strings: [], known: true }
        const vertical = value.known && value.strings.length > 0 && value.strings.every(item => item === 'vertical')
        if (!vertical) add(node, 'style/no-horizontal-rule', '禁止水平 <Separator />；用间距或背景分组，只保留竖线分隔。')
      }
      if (name === 'Button' && (attr(node, 'isLoading') || attr(node, 'isPending'))) add(node, 'composition/button-loading', 'Button 使用 Spinner + disabled，不存在 isLoading/isPending。')
      if (['Input', 'Textarea'].includes(name) && parents.includes('InputGroup')) add(node, 'forms/input-group', 'InputGroup 内使用 InputGroupInput/InputGroupTextarea。')
      if (['Input', 'Textarea', 'Checkbox', 'Switch', 'NativeSelect'].includes(name) && parents.includes('form') && !parents.includes('Field')) add(node, 'forms/field', '表单控件使用 FieldGroup + Field，不手写字段容器。')
      if (name === 'Field' && !parents.includes('FieldGroup')) add(node, 'forms/field-group', 'Field 必须在 FieldGroup 中组合。')
      if (name === 'Field' && attr(node, 'data-invalid') && !containsInvalidControl(node, source)) add(node, 'forms/invalid-state', 'Field data-invalid 需配合控件 aria-invalid。')
      if (name === 'Button' && parents.includes('InputGroup') && !parents.includes('InputGroupAddon')) add(node, 'forms/input-addon', 'InputGroup 中按钮必须位于 InputGroupAddon。')
      if (name === 'Card' && (!contains(node, 'CardHeader') || !contains(node, 'CardContent'))) add(node, 'composition/card', 'Card 使用 CardHeader 与 CardContent；不要仅塞入 CardContent。')
      if (policy.base === 'base' && /^(?:DropdownMenuItem|ContextMenuItem|MenubarItem)$/.test(name) && attr(node, 'onSelect')) add(node, 'composition/base-events', 'Base UI 菜单项使用 onClick，不使用 Radix 的 onSelect。')
      if (policy.base === 'base' && attr(node, 'asChild')) add(node, 'composition/base-render', '当前为 Base UI，使用 render，不使用 Radix 的 asChild。')
      const iconAttr = attr(node, 'icon')
      if (iconAttr?.initializer && ts.isStringLiteral(iconAttr.initializer)) add(iconAttr, 'icons/component-reference', 'icon 传组件对象，不传字符串。')
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return diagnostics
}

function containsInvalidControl(node, source) {
  let result = false
  function visit(child) {
    if ((ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child)) && child.attributes.properties.some(p => ts.isJsxAttribute(p) && p.name.getText(source) === 'aria-invalid')) result = true
    ts.forEachChild(child, visit)
  }
  if (ts.isJsxElement(node.parent)) node.parent.children.forEach(visit)
  return result
}

export function auditCss(file, text, policy) {
  const diagnostics = []
  const add = (node, rule, message) => diagnostics.push({ file, line: node.source?.start?.line ?? 1, column: node.source?.start?.column ?? 1, rule, message })
  let root
  try { root = postcss.parse(text, { from: file }) }
  catch (error) { return [{ file, line: error.line ?? 1, column: error.column ?? 1, rule: 'style/css-parse', message: error.reason }] }
  root.walkDecls(node => {
    if (/^(?:font(?:-.+)?|line-height|letter-spacing|--text-.+|--leading-.+|--tracking-.+|--font-weight-.+)$/.test(node.prop)) add(node, 'typography/no-css-values', '不允许 CSS 自定义排版值或重定义 Tailwind 字体档位。')
    if (node.prop.startsWith('--font-')) {
      const permitted = { '--font-sans': 'var(--font-geist), "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", ui-sans-serif, system-ui, sans-serif', '--font-heading': 'var(--font-sans)' }
      if (node.prop in permitted && permitted[node.prop] !== node.value) add(node, 'typography/font-token', `${node.prop} 不在批准的字体 token 映射中。`)
    }
    if (!node.prop.startsWith('--') && !/^(?::root|\.dark|\*|body|html)$/.test(node.parent.selector ?? '')) add(node, 'style/no-custom-css', '业务样式不通过 CSS 选择器绕过组件预设。')
  })
  root.walkRules(node => {
    if (![':root', '.dark', '*', 'body', 'html'].includes(node.selector)) add(node, 'style/no-custom-css', `不允许自绘样式选择器 ${node.selector}。`)
  })
  root.walkAtRules(node => {
    if (node.name === 'apply') {
      for (const token of splitUtilities(node.params)) checkUtility(token, policy, (rule, message) => add(node, rule, message))
      const baseline = node.parent?.selector === '*' && node.params === 'border-border outline-ring/50' || node.parent?.selector === 'body' && node.params === 'bg-background text-foreground'
      if (!baseline) add(node, 'style/no-custom-css', '只保留全局基线 @apply，组件样式来自 registry。')
    }
    if (node.name.endsWith('keyframes') || node.name === 'utility' || node.name === 'font-face') add(node, 'style/no-custom-css', '不手写动画、字体或 utility 来绕过 registry 预设。')
    if (node.name === 'import' && !['"tailwindcss"', '"tw-animate-css"', '"shadcn/tailwind.css"'].includes(node.params)) add(node, 'style/no-custom-css', '全局样式导入需要显式审核，不能引入自绘 CSS。')
  })
  return diagnostics
}
