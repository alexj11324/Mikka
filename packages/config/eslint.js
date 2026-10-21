// Shared flat ESLint config for every Orvilo workspace.
import js from "@eslint/js"
import i18next from "eslint-plugin-i18next"
import reactHooks from "eslint-plugin-react-hooks"
import globals from "globals"
import tseslint from "typescript-eslint"

/** Base rules for TypeScript + React code in any workspace. */
export const base = tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: { globals: { ...globals.node } },
  }
)

/**
 * User-facing text must go through i18next. Applied to renderer code only:
 * JSX text has to come from t(), never a literal.
 */
export function noLiteralStrings(files) {
  return {
    files,
    plugins: { i18next },
    rules: {
      "i18next/no-literal-string": ["error", { mode: "jsx-text-only" }],
    },
  }
}

// Raw elements that have an installed @orvilo/ui component.
const RAW_ELEMENTS = {
  button: "Button (@orvilo/ui/components/ui/button)",
  input: "Input / InputGroup (@orvilo/ui/components/ui/input)",
  select: "Select (@orvilo/ui/components/ui/select)",
  textarea: "Textarea (@orvilo/ui/components/ui/textarea)",
  dialog: "Dialog (@orvilo/ui/components/ui/dialog)",
  aside: "Sidebar (an installed sidebar block)",
  nav: "Sidebar / Breadcrumb (@orvilo/ui/components/ui/…)",
  table: "Table / DataGrid (@orvilo/ui/components/ui/table)",
  kbd: "Kbd (@orvilo/ui/components/ui/kbd)",
}

/**
 * Renderer screens compose installed registry components; a raw element
 * that has an @orvilo/ui equivalent is a hand-rolled copy (DESIGN.md).
 * `ignores` lists files still being rebuilt (ui-surfaces.json legacy).
 *
 * `render={<a />}` / `render={<span />}` is exempt: Base UI's `render` prop
 * replaces the host element, so a semantic tag there is the composition API
 * (`Button render={<a />}`, `Item render={<div />}`), not a hand-rolled
 * control. Form controls are NOT exempt: `render={<button />}` is exactly the
 * raw `<button>` this rule exists to stop — the replacement is
 * `render={<Button />}`.
 */
const RENDER_PROP_TARGET =
  'JSXAttribute[name.name="render"] JSXElement > JSXOpeningElement'

/** Native controls that stay banned even as a render-prop host. */
const RENDER_PROP_CONTROLS = new Set(["button", "input", "select", "textarea"])

const rawElementSelector = (name) =>
  RENDER_PROP_CONTROLS.has(name)
    ? `JSXOpeningElement[name.name="${name}"]`
    : `JSXOpeningElement[name.name="${name}"]:not(${RENDER_PROP_TARGET})`

export function noRawElements(files, ignores = []) {
  return {
    files,
    ignores,
    rules: {
      "no-restricted-syntax": [
        "error",
        ...Object.entries(RAW_ELEMENTS).map(([name, use]) => ({
          selector: rawElementSelector(name),
          message: `Raw <${name}>: use @orvilo/ui ${use} instead.`,
        })),
      ],
    },
  }
}

/** Shown on every banned control import. ESLint appends it to its own preamble. */
export const USE_ORVILO_UI = "use @orvilo/ui"

/**
 * Import specifiers that resolve to the UI's `components/ui` from outside
 * that directory. `@orvilo/ui/components/ui/*` is the replacement and must
 * not match. `../ui/debounced-input` is a different folder
 * (`data-table-filter/ui`) and stays allowed.
 */
export const LEGACY_UI_IMPORT_PATTERN =
  "^(?:@/components/ui(?:/.+)?|(?:\\.{1,2}/)+components/ui(?:/.+)?|(?:\\.\\./)+ui/(?!debounced-input(?:\\.[jt]sx?)?$).+)$"

/**
 * Renderer code composes `@orvilo/ui`. The vendored primitives that
 * used to live in the old `components/ui`, and `tailwindcss-animate`, are not
 * available at all — the directory is gone (ADR ORV-283).
 */
export function noLegacyControlImports(files, ignores = []) {
  return {
    files,
    ignores,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@radix-ui/*", "@radix-ui/**"],
              message: USE_ORVILO_UI,
            },
            {
              group: ["tailwindcss-animate", "tailwindcss-animate/*"],
              message: USE_ORVILO_UI,
            },
            {
              regex: LEGACY_UI_IMPORT_PATTERN,
              message: USE_ORVILO_UI,
            },
          ],
        },
      ],
    },
  }
}

// A control counts as wired when it has one of these. `type` includes
// type="submit"; a menu trigger parent is the other way a button acts.
const ACTION_ATTRS = new Set([
  "onClick",
  "type",
  "asChild",
  "render",
  "form",
  "href",
])

function jsxTagName(name) {
  if (!name) return null
  if (name.type === "JSXIdentifier") return name.name
  if (name.type === "JSXMemberExpression") return name.property?.name ?? null
  return null
}

function attrName(attr) {
  if (attr.type !== "JSXAttribute") return null
  return attr.name?.name ?? null
}

function hasActionAttr(opening) {
  return opening.attributes.some((attr) => ACTION_ATTRS.has(attrName(attr)))
}

/** Allowlist keys are paths under `renderer/`, whatever ESLint's filename is. */
function rendererRelative(filename) {
  const normalized = String(filename).replaceAll("\\", "/")
  const marker = "apps/desktop/src/renderer/"
  const at = normalized.lastIndexOf(marker)
  if (at >= 0) return normalized.slice(at + marker.length)
  return normalized
}

function insideTrigger(node) {
  let parent = node.parent
  while (parent) {
    if (parent.type === "JSXElement") {
      const name = jsxTagName(parent.openingElement.name)
      if (typeof name === "string" && name.endsWith("Trigger")) return true
    }
    parent = parent.parent
  }
  return false
}

/**
 * A component that spreads its props onto the control it renders
 * (`<Button {...props} />`) gets its action from its caller — the wrapper
 * itself cannot be judged inert.
 */
function forwardsProps(node) {
  return node.attributes.some((attr) => attr.type === "JSXSpreadAttribute")
}

/** `onClick={() => {}}` and `onClick={() => { }}`, nothing else. */
function isEmptyArrow(attr) {
  const value = attr.value
  if (!value || value.type !== "JSXExpressionContainer") return false
  const expr = value.expression
  if (
    expr.type !== "ArrowFunctionExpression" &&
    expr.type !== "FunctionExpression"
  ) {
    return false
  }
  if (expr.body.type !== "BlockStatement") return false
  return expr.body.body.length === 0
}

/**
 * UI controls that do nothing (ADR ORV-264). A `<Button>` or `<button>`
 * needs onClick, type, asChild, render, form, or href, unless a *Trigger
 * parent supplies the action. An empty `onClick={() => {}}` is an error on
 * any element. `allowlist` is per file and only shrinks: a file may not grow
 * past its recorded counts, and a fix has to lower them in the same change.
 */
export const inertControls = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Buttons need an action; empty onClick handlers are not an action.",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowlist: { type: "object", additionalProperties: true },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      inert:
        "<{{tag}}> has no action. Add onClick, type, asChild, render, form, or href, or hide it behind a feature flag and keep it on the allowlist.",
      empty:
        "Empty onClick does nothing. Call the real action, or drop the handler and hide the control behind a feature flag.",
      grew: "{{file}} has {{actual}} {{kind}} control(s); the allowlist only permits {{allowed}}. New inert controls are not allowed.",
      shrink:
        "{{file}} has {{actual}} {{kind}} control(s) but the allowlist still permits {{allowed}}. Lower the allowlist in this change.",
    },
  },
  create(context) {
    const allowlist = context.options[0]?.allowlist ?? null
    const filename = rendererRelative(context.filename ?? context.getFilename())
    let inert = 0
    let empty = 0
    return {
      JSXOpeningElement(node) {
        const tag = jsxTagName(node.name)
        if (
          (tag === "Button" || tag === "button") &&
          !insideTrigger(node) &&
          !forwardsProps(node) &&
          !hasActionAttr(node)
        ) {
          inert += 1
          if (!allowlist)
            context.report({ node, messageId: "inert", data: { tag } })
        }
        const onClick = node.attributes.find(
          (attr) => attrName(attr) === "onClick"
        )
        if (onClick && isEmptyArrow(onClick)) {
          empty += 1
          if (!allowlist) context.report({ node: onClick, messageId: "empty" })
        }
      },
      "Program:exit"() {
        if (!allowlist) return
        const entry = allowlist[filename] ?? { inert: 0, empty: 0 }
        for (const kind of ["inert", "empty"]) {
          const actual = kind === "inert" ? inert : empty
          const allowed = entry[kind] ?? 0
          if (actual === allowed) continue
          context.report({
            loc: { line: 1, column: 0 },
            messageId: actual > allowed ? "grew" : "shrink",
            data: { file: filename, kind, actual, allowed },
          })
        }
      },
    }
  },
}

/**
 * Applies the inert-control rule. `allowlist` keys are paths under
 * `renderer/`. Counts only shrink (ADR ORV-264).
 */
export function noInertControls(files, allowlist = null, ignores = []) {
  return {
    files,
    ignores,
    plugins: { orvilo: { rules: { "no-inert-control": inertControls } } },
    rules: {
      "orvilo/no-inert-control": ["error", allowlist ? { allowlist } : {}],
    },
  }
}

// Plain DOM elements given a click/key handler or an interactive role are a
// hand-rolled control. The message names the @orvilo/ui component to use.
const INTERACTIVE_HANDLERS = new Set([
  "onClick",
  "onDoubleClick",
  "onKeyDown",
  "onKeyUp",
  "onKeyPress",
  "onMouseDown",
  "onMouseUp",
  "onPointerDown",
  "onPointerUp",
])

// Native elements that may own a handler: real form controls (themselves
// covered by noRawElements), and wrappers that only receive bubbled events.
const NATIVE_INTERACTIVE = new Set([
  "button",
  "input",
  "select",
  "textarea",
  "option",
  "summary",
  "form",
  "label",
])

const ROLE_COMPONENTS = {
  button: "Button",
  link: "Button asChild / Link",
  tab: "Tabs (TabsTrigger)",
  tablist: "Tabs (TabsList)",
  menuitem: "DropdownMenu / ContextMenu (…MenuItem)",
  menuitemcheckbox: "DropdownMenuCheckboxItem",
  menuitemradio: "DropdownMenuRadioItem",
  menu: "DropdownMenu / ContextMenu",
  menubar: "Menubar",
  checkbox: "Checkbox",
  switch: "Switch",
  radio: "RadioGroup",
  radiogroup: "RadioGroup",
  option: "Select / Command (CommandItem)",
  listbox: "Select / Command",
  combobox: "Combobox / Command",
  slider: "Slider",
  dialog: "Dialog / Sheet",
  alertdialog: "AlertDialog",
  tooltip: "Tooltip",
}

function isIntrinsic(node) {
  return node.name?.type === "JSXIdentifier" && /^[a-z]/.test(node.name.name)
}

function staticString(attr) {
  const v = attr.value
  if (!v) return null
  if (v.type === "Literal" && typeof v.value === "string") return v.value
  if (v.type === "JSXExpressionContainer") {
    const e = v.expression
    if (e.type === "Literal" && typeof e.value === "string") return e.value
    if (e.type === "TemplateLiteral" && e.expressions.length === 0)
      return e.quasis[0].value.cooked
  }
  return null
}

export const handwrittenControls = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Plain elements must not act as controls; compose an @orvilo/ui component.",
    },
    schema: [],
    messages: {
      handler:
        "<{{tag}} {{attr}}> is a hand-written control. Use @orvilo/ui Button (or the matching component: Toggle, Tabs, DropdownMenu, Collapsible, Command…) instead.",
      role: '<{{tag}} role="{{role}}"> is a hand-written control. Use @orvilo/ui {{use}} instead.',
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (!isIntrinsic(node)) return
        const tag = node.name.name
        if (NATIVE_INTERACTIVE.has(tag)) return
        // A real link (<a href>) may intercept its own click for routing.
        const isLink =
          tag === "a" && node.attributes.some((a) => attrName(a) === "href")
        for (const attr of node.attributes) {
          const name = attrName(attr)
          if (INTERACTIVE_HANDLERS.has(name) && !isLink) {
            context.report({
              node: attr,
              messageId: "handler",
              data: { tag, attr: name },
            })
          } else if (name === "role") {
            const role = staticString(attr)
            if (role && ROLE_COMPONENTS[role]) {
              context.report({
                node: attr,
                messageId: "role",
                data: { tag, role, use: ROLE_COMPONENTS[role] },
              })
            }
          }
        }
      },
    }
  },
}

// Inline style properties that are hand-written visual styling when given a
// literal value. A computed value (data colour, measured width, offset) or a
// CSS variable is allowed: only the literal is a substitute for a class/token.
const VISUAL_STYLE =
  /^(color|background|backgroundColor|backgroundImage|border|border[A-Z].*|outline|outline[A-Z].*|boxShadow|textShadow|font|font[A-Z].*|lineHeight|letterSpacing|textTransform|textDecoration|padding|padding[A-Z].*|margin|margin[A-Z].*|gap|rowGap|columnGap|opacity|fill|stroke|borderRadius)$/

function isLiteralValue(expr) {
  if (!expr) return false
  if (expr.type === "Literal") return true
  if (expr.type === "TemplateLiteral") return expr.expressions.length === 0
  if (expr.type === "UnaryExpression") return isLiteralValue(expr.argument)
  return false
}

function propKey(prop) {
  if (prop.type !== "Property") return null
  if (prop.key.type === "Identifier" && !prop.computed) return prop.key.name
  if (prop.key.type === "Literal") return String(prop.key.value)
  return null
}

function literalUsesVar(expr) {
  const s =
    expr.type === "Literal"
      ? String(expr.value)
      : expr.quasis?.[0]?.value.cooked
  return typeof s === "string" && s.includes("var(--")
}

export const staticInlineStyles = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Literal visual inline styles are hand-written styling; use classes, tokens or @orvilo/ui variants.",
    },
    schema: [],
    messages: {
      literal:
        "style={{ {{key}}: … }} is a hard-coded visual style. Use a Tailwind class / design token or the @orvilo/ui component variant. Inline style is only for computed values and CSS variables.",
    },
  },
  create(context) {
    return {
      JSXAttribute(attr) {
        if (attr.name?.name !== "style") return
        const value = attr.value
        if (!value || value.type !== "JSXExpressionContainer") return
        const objects = []
        const collect = (e) => {
          if (!e) return
          if (e.type === "ObjectExpression") objects.push(e)
          else if (e.type === "ConditionalExpression") {
            collect(e.consequent)
            collect(e.alternate)
          } else if (e.type === "LogicalExpression") collect(e.right)
          else if (
            e.type === "TSAsExpression" ||
            e.type === "TSSatisfiesExpression"
          )
            collect(e.expression)
        }
        collect(value.expression)
        for (const obj of objects) {
          for (const prop of obj.properties) {
            const key = propKey(prop)
            if (!key || key.startsWith("--") || !VISUAL_STYLE.test(key))
              continue
            if (isLiteralValue(prop.value) && !literalUsesVar(prop.value)) {
              context.report({
                node: prop,
                messageId: "literal",
                data: { key },
              })
            }
          }
        }
      },
    }
  },
}

// Hex / rgb() / hsl() literals inside className, including Tailwind arbitrary
// values like bg-[#fff]. Colours come from theme tokens.
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/

export const hardcodedColors = {
  meta: {
    type: "problem",
    docs: { description: "No hard-coded colour literals in className." },
    schema: [],
    messages: {
      color:
        "Hard-coded colour in className. Use a theme token class (bg-primary, text-muted-foreground, border-border…).",
    },
  },
  create(context) {
    const check = (node, s) => {
      if (typeof s === "string" && COLOR_LITERAL.test(s))
        context.report({ node, messageId: "color" })
    }
    const walk = (e) => {
      if (!e) return
      if (e.type === "Literal") check(e, e.value)
      else if (e.type === "TemplateLiteral")
        e.quasis.forEach((q) => check(e, q.value.cooked))
      else if (e.type === "CallExpression") e.arguments.forEach(walk)
      else if (e.type === "ConditionalExpression") {
        walk(e.consequent)
        walk(e.alternate)
      } else if (e.type === "LogicalExpression") walk(e.right)
    }
    return {
      JSXAttribute(attr) {
        const n = attr.name?.name
        if (n !== "className") return
        const v = attr.value
        if (!v) return
        if (v.type === "Literal") check(v, v.value)
        else if (v.type === "JSXExpressionContainer") walk(v.expression)
      },
    }
  },
}

/**
 * Appearance classes on plain elements. Layout classes (flex, gap, p-…) are
 * fine; anything that draws a surface — borders, radii, background, shadow,
 * ring, dividers, text colour — belongs to a component. This is what catches
 * hand-built tables, badges and cards that the control rules cannot see
 * (ORV-283).
 */
const APPEARANCE_CLASS =
  /^(?:[a-z0-9]+:)*[-!]?(?:border|rounded|bg|shadow|ring|divide|outline)(?:$|[-/[])/

/** Plain elements that must not draw their own surface. */
const SURFACE_ELEMENTS = new Set([
  "div",
  "span",
  "li",
  "ul",
  "ol",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "caption",
  "section",
  "article",
  "header",
  "footer",
  "aside",
  "main",
  "nav",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "em",
  "small",
  "code",
  "pre",
  "blockquote",
  "dl",
  "dt",
  "dd",
  "figure",
  "figcaption",
])

/** Classes that are appearance even though the prefix looks structural. */
const APPEARANCE_ALLOW = new Set([
  "text-left",
  "text-center",
  "text-right",
  "text-start",
  "text-end",
  "text-balance",
  "text-pretty",
  "text-wrap",
  "text-nowrap",
  "text-ellipsis",
  "text-clip",
])

/** Layout-only escape hatch, for the few places a plain element must be seen. */
const APPEARANCE_IGNORE = /orvilo-ui-allow-appearance/

export const handwrittenSurfaces = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Plain elements must not style their own surface; use an @orvilo/ui component.",
    },
    schema: [],
    messages: {
      surface:
        '<{{tag}}> draws its own surface with "{{cls}}". Use an @orvilo/ui component (Card, Table, Badge, Separator, Item…) or a ReUI block instead of styling a plain element.',
    },
  },
  create(context) {
    const report = (node, tag, classes) => {
      for (const cls of classes) {
        if (!cls || APPEARANCE_ALLOW.has(cls)) continue
        if (!APPEARANCE_CLASS.test(cls)) continue
        context.report({ node, messageId: "surface", data: { tag, cls } })
        return
      }
    }
    const check = (node, tag, value) => {
      if (!value) return
      const raw =
        value.type === "Literal"
          ? String(value.value)
          : value.type === "TemplateLiteral"
            ? value.quasis.map((q) => q.value.cooked ?? "").join(" ")
            : null
      if (raw === null) return
      if (APPEARANCE_IGNORE.test(raw)) return
      report(node, tag, raw.split(/\s+/).filter(Boolean))
    }
    return {
      JSXOpeningElement(node) {
        if (!isIntrinsic(node)) return
        const tag = node.name.name
        if (!SURFACE_ELEMENTS.has(tag)) return
        for (const attr of node.attributes) {
          const name = attrName(attr)
          if (name !== "className" && name !== "class") continue
          const v = attr.value
          if (!v) continue
          if (v.type === "Literal") check(attr, tag, v)
          else if (v.type === "JSXExpressionContainer") {
            const e = v.expression
            if (e.type === "ConditionalExpression") {
              check(attr, tag, e.consequent)
              check(attr, tag, e.alternate)
            } else if (e.type === "LogicalExpression") {
              check(attr, tag, e.right)
            } else {
              check(attr, tag, e)
            }
          }
        }
      },
    }
  },
}

// Roles that describe a component's structure. A plain element carrying one
// is a hand-built table, grid, progress bar or tab panel; the matching
// @orvilo/ui component already renders the role (ORV-283).
const SEMANTIC_ROLES = new Set([
  "table",
  "row",
  "grid",
  "gridcell",
  "cell",
  "columnheader",
  "rowheader",
  "list",
  "listitem",
  "progressbar",
  "separator",
  "status",
  "tabpanel",
  "tablist",
  "tab",
  "meter",
  "tooltip",
  "alert",
])

export const semanticRoles = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Plain elements must not carry semantic roles; use the @orvilo/ui component.",
    },
    schema: [],
    messages: {
      role: '<{{tag}} role="{{role}}"> is a hand-built semantic. Use the matching @orvilo/ui component (Table, Progress, Separator, Tabs, Tooltip, Alert…) instead.',
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (!isIntrinsic(node)) return
        const tag = node.name.name
        for (const attr of node.attributes) {
          if (attrName(attr) !== "role") continue
          const role = staticString(attr)
          if (!role || !SEMANTIC_ROLES.has(role)) continue
          // tab, tablist and tooltip already map to a component in
          // handwrittenControls; report each element once.
          if (ROLE_COMPONENTS[role]) continue
          context.report({ node: attr, messageId: "role", data: { tag, role } })
        }
      },
    }
  },
}

// `title` opens the browser's own tooltip: it cannot be styled, and it is not
// announced consistently. Tooltip is the component (ORV-283).
export const nativeTitles = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Native title= is a browser tooltip; use the @orvilo/ui Tooltip.",
    },
    schema: [],
    messages: {
      title:
        "<{{tag}} title> is a native browser tooltip. Use @orvilo/ui Tooltip instead.",
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (!isIntrinsic(node)) return
        const tag = node.name.name
        for (const attr of node.attributes) {
          if (attrName(attr) !== "title") continue
          context.report({ node: attr, messageId: "title", data: { tag } })
        }
      },
    }
  },
}

// A link painted like a button (border, radius, background) duplicates Button
// and drifts from it. Compose Button with `render={<Link />}` instead: one
// component, link semantics (ORV-283).
const LINK_SURFACE_CLASS =
  /^(?:[a-z0-9]+:)*[-!]?(?:border|rounded|bg)(?:$|[-/[])/
const LINK_TAGS = new Set(["a", "Link"])

/** String literals inside a className attribute, including cn(…) arguments. */
function classLiterals(attr) {
  const v = attr.value
  if (!v) return []
  if (v.type === "Literal") return typeof v.value === "string" ? [v.value] : []
  if (v.type !== "JSXExpressionContainer") return []
  const out = []
  const walk = (e) => {
    if (!e) return
    if (e.type === "Literal") {
      if (typeof e.value === "string") out.push(e.value)
    } else if (e.type === "TemplateLiteral") {
      out.push(e.quasis.map((q) => q.value.cooked ?? "").join(" "))
    } else if (e.type === "CallExpression") {
      e.arguments.forEach(walk)
    } else if (e.type === "ConditionalExpression") {
      walk(e.consequent)
      walk(e.alternate)
    } else if (e.type === "LogicalExpression") walk(e.right)
  }
  walk(v.expression)
  return out
}

export const linkAsButton = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Links must not style themselves as buttons; use Button with render={<Link />}.",
    },
    schema: [],
    messages: {
      link: '<{{tag}} className="{{cls}}"> paints a link as a button. Use @orvilo/ui Button with render={<Link … />} instead.',
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name?.type !== "JSXIdentifier") return
        const tag = node.name.name
        if (!LINK_TAGS.has(tag)) return
        for (const attr of node.attributes) {
          const name = attrName(attr)
          if (name !== "className" && name !== "class") continue
          const cls = classLiterals(attr)
            .flatMap((s) => s.split(/\s+/))
            .find((c) => c && LINK_SURFACE_CLASS.test(c))
          if (!cls) continue
          context.report({ node: attr, messageId: "link", data: { tag, cls } })
        }
      },
    }
  },
}

// The type scale is a closed set: text-xs, text-sm, text-base, text-lg,
// text-xl, text-2xl, text-3xl. An absolute text-[13px] / text-[0.8rem] is how
// two rows that should match end up a fraction of a pixel apart, and how
// sub-12px text (below ReUI's floor) gets in. Relative em values stay allowed:
// inline code and marks are meant to scale with the text around them.
const ARBITRARY_TEXT_SIZE =
  /(?:^|[\s"'`])(?:[a-z0-9]+:)*[-!]?text-\[([^\]]+)\]/g
/** Values that carry a length unit are sizes; `rgb(...)`/`var(...)` are not. */
const ABSOLUTE_TEXT_UNIT = /(px|rem|pt|pc|cm|mm|in|q)$/i
const RELATIVE_TEXT_UNITS = new Set(["em", "ex", "ch"])

export const arbitraryTextSizes = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Font sizes come from the type scale, not from one-off values.",
    },
    schema: [],
    messages: {
      size: "text-[{{value}}] is outside the type scale. Use text-xs, text-sm, text-base, text-lg, text-xl, text-2xl or text-3xl.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode()
    return {
      JSXAttribute(node) {
        const name = attrName(node)
        if (name !== "className" && name !== "class") return
        const raw = sourceCode.getText(node.value)
        for (const match of raw.matchAll(ARBITRARY_TEXT_SIZE)) {
          const value = match[1]
          const unit = value.match(/([a-z%]+)$/i)?.[1]?.toLowerCase()
          if (unit && RELATIVE_TEXT_UNITS.has(unit)) continue
          if (!ABSOLUTE_TEXT_UNIT.test(value)) continue
          context.report({ node, messageId: "size", data: { value } })
        }
      },
    }
  },
}

// Icons inside an @orvilo/ui component that sizes its own icons are sized by
// that component's CSS; a size-* class there is hand-fighting it (shadcn icons
// rule). A standalone icon picks from the closed scale: 12/16/20/24 for inline
// icons (size-3/4/5/6) and 32/40/48 for illustrations (size-8/10/12).
// Avatar initials are text-xs so a 16px and a 24px avatar read as one system.
const ICON_SCALE = new Set([
  "size-3",
  "size-4",
  "size-5",
  "size-6",
  "size-8",
  "size-10",
  "size-12",
])
/** Components whose CSS already sizes the icons they contain. */
const ICON_SIZING_COMPONENT =
  /^(?:Button|Toggle|ToggleGroupItem|Badge|SidebarMenuButton|SidebarMenuAction|SidebarMenuSubButton|DropdownMenuItem|DropdownMenuCheckboxItem|DropdownMenuRadioItem|DropdownMenuSubTrigger|ContextMenuItem|SelectItem|CommandItem|MenubarItem)$/
const ICON_SIZE_CLASS =
  /(?:^|[\s"'`])[-!]?size-(\[[^\]]+\]|[0-9.]+)(?:$|[\s"'`])/

function componentAncestor(node) {
  let parent = node.parent
  while (parent) {
    if (parent.type === "JSXElement" && parent.openingElement !== node) {
      const name = jsxTagName(parent.openingElement.name)
      if (typeof name === "string" && ICON_SIZING_COMPONENT.test(name)) {
        return name
      }
    }
    parent = parent.parent
  }
  return null
}

function classStrings(node) {
  const attr = node.attributes.find(
    (candidate) =>
      attrName(candidate) === "className" || attrName(candidate) === "class"
  )
  if (!attr?.value) return []
  if (attr.value.type === "Literal") return [String(attr.value.value)]
  if (attr.value.type === "TemplateLiteral") {
    return [attr.value.quasis.map((q) => q.value.cooked ?? "").join(" ")]
  }
  if (attr.value.type === "JSXExpressionContainer") {
    const texts = []
    const walk = (n) => {
      if (!n || typeof n !== "object") return
      if (n.type === "Literal" && typeof n.value === "string")
        texts.push(n.value)
      if (n.type === "TemplateLiteral")
        texts.push(n.quasis.map((q) => q.value.cooked ?? "").join(" "))
      for (const key of Object.keys(n)) {
        if (key === "parent") continue
        const child = n[key]
        if (Array.isArray(child)) child.forEach(walk)
        else if (child && typeof child.type === "string") walk(child)
      }
    }
    walk(attr.value.expression)
    return texts
  }
  return []
}

/** Guard against a cartesian product that grows past what review can read. */
const CLASS_OUTCOME_LIMIT = 32
/** Functions whose arguments all land on the element, so their classes combine. */
const CLASS_JOINERS = new Set(["cn", "clsx"])

/**
 * A template literal whose holes are all literals reads as one string.
 * `null` means a hole is a runtime value.
 */
function templateText(node) {
  let text = node.quasis[0]?.value.cooked ?? ""
  for (let index = 0; index < node.expressions.length; index += 1) {
    const expression = node.expressions[index]
    if (expression.type !== "Literal") return null
    if (!["string", "number"].includes(typeof expression.value)) return null
    text += String(expression.value)
    text += node.quasis[index + 1]?.value.cooked ?? ""
  }
  return text
}

/** The `const` behind an identifier reference, or `null` when it is not one. */
function constVariable(identifier, sourceCode) {
  if (typeof sourceCode.getScope !== "function") return null
  let scope = sourceCode.getScope(identifier)
  while (scope) {
    const variable = scope.set?.get(identifier.name)
    if (variable) {
      const definition = variable.defs.find(
        (candidate) => candidate.type === "Variable"
      )
      if (!definition) return null
      return definition.parent?.kind === "const" ? variable : null
    }
    scope = scope.upper
  }
  return null
}

/**
 * The class strings a `className` expression can produce, one entry per
 * rendered outcome. `cn("shrink-0", showName ? "size-4" : "size-5")` yields
 * `[["shrink-0", "size-4"], ["shrink-0", "size-5"]]` — the two branches never
 * apply together, so each is judged on its own.
 *
 * A `null` entry means part of the expression cannot be read statically (a
 * runtime value, a prop, an import); callers treat that as a size review
 * cannot see.
 *
 * Unlike `classStrings`, this follows local `const`s and keeps the branches
 * apart, so a named size that is literal in every branch stays visible.
 */
function classOutcomes(node, context) {
  const sourceCode = context.sourceCode ?? context.getSourceCode()

  /** Every argument of `cn` applies at once, so the outcomes multiply. */
  const combine = (groups) => {
    let result = [[]]
    for (const group of groups) {
      const next = []
      for (const left of result) {
        for (const right of group) {
          if (left === null || right === null) next.push(null)
          else next.push([...left, ...right])
        }
      }
      if (next.length > CLASS_OUTCOME_LIMIT) return [null]
      result = next
    }
    return result.length > 0 ? result : [[]]
  }

  /** Classes of one expression; branches stay apart, `cn` arguments combine. */
  const outcomes = (expression, seen) => {
    if (!expression) return [null]
    switch (expression.type) {
      case "Literal":
        if (typeof expression.value === "string") return [[expression.value]]
        // `cn(cond && "x")` and `cn(false)` contribute nothing.
        if (expression.value == null || expression.value === false) return [[]]
        return [null]
      case "TemplateLiteral": {
        const text = templateText(expression)
        return text === null ? [null] : [[text]]
      }
      // Only one branch renders, so the outcomes are the union of both.
      case "ConditionalExpression":
        return [
          ...outcomes(expression.consequent, seen),
          ...outcomes(expression.alternate, seen),
        ]
      case "LogicalExpression":
        return [
          ...outcomes(expression.left, seen),
          ...outcomes(expression.right, seen),
        ]
      case "ArrayExpression": {
        const groups = []
        for (const element of expression.elements) {
          if (!element || element.type === "SpreadElement") groups.push(null)
          else groups.push(...outcomes(element, seen))
        }
        return groups.length > 0 ? groups : [[]]
      }
      // Every argument of `cn` applies at once, so the outcomes multiply.
      case "CallExpression": {
        const { callee } = expression
        const name =
          callee.type === "Identifier"
            ? callee.name
            : callee.type === "MemberExpression" && !callee.computed
              ? callee.property.name
              : null
        if (!CLASS_JOINERS.has(name)) return [null]
        return combine(expression.arguments.map((arg) => outcomes(arg, seen)))
      }
      case "Identifier": {
        const variable = constVariable(expression, sourceCode)
        if (!variable || seen.has(variable)) return [null]
        const declarator = variable.defs.find(
          (candidate) => candidate.type === "Variable"
        )?.node
        if (!declarator?.init) return [null]
        seen.add(variable)
        const resolved = outcomes(declarator.init, seen)
        seen.delete(variable)
        return resolved
      }
      default:
        return [null]
    }
  }

  const attr = node.attributes.find(
    (candidate) =>
      attrName(candidate) === "className" || attrName(candidate) === "class"
  )
  if (!attr?.value) return [[]]
  if (attr.value.type === "Literal") return [[String(attr.value.value)]]
  if (attr.value.type === "TemplateLiteral") {
    const text = templateText(attr.value)
    return text === null ? [null] : [[text]]
  }
  if (attr.value.type !== "JSXExpressionContainer") return [[]]
  return outcomes(attr.value.expression, new Set())
}

export const iconSizes = {
  meta: {
    type: "problem",
    fixable: "code",
    docs: {
      description:
        "Icons follow the component's sizing or the 12/16/20/24 icon scale.",
    },
    schema: [],
    messages: {
      inside:
        'The icon inside <{{parent}}> is sized by that component. Remove the size class (Button labels use data-icon="inline-start").',
      outside:
        "size-{{value}} is off the icon scale. Use size-3/4/5/6 (12/16/20/24) for inline icons, or size-8/10/12 (32/40/48) for illustrations.",
    },
  },
  create(context) {
    const fixSize = (attr, value, fixer) => {
      if (!attr?.value) return null
      if (
        attr.value.type === "Literal" &&
        typeof attr.value.value === "string"
      ) {
        const text = attr.value.value
        const pattern = new RegExp(
          `(^|\\s)${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`
        )
        const next = text.replace(pattern, "$1").trim().replace(/\s+/g, " ")
        return next
          ? fixer.replaceText(attr.value, JSON.stringify(next))
          : fixer.remove(attr)
      }
      if (
        attr.value.type === "TemplateLiteral" &&
        attr.value.expressions.length === 0
      ) {
        const text = attr.value.quasis[0]?.value.cooked ?? ""
        const pattern = new RegExp(
          `(^|\\s)${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`
        )
        const next = text.replace(pattern, "$1").trim()
        return next
          ? fixer.replaceText(
              attr.value,
              `{\`${next.replaceAll("`", "\\`")}\`}`
            )
          : null
      }
      return null
    }
    const check = (node) => {
      const tag = jsxTagName(node.name)
      if (tag !== "HugeiconsIcon") return
      const attr = node.attributes.find(
        (candidate) =>
          attrName(candidate) === "className" || attrName(candidate) === "class"
      )
      for (const raw of classStrings(node)) {
        const match = raw.match(ICON_SIZE_CLASS)
        if (!match) continue
        const value = match[1]
        const parent = componentAncestor(node)
        if (parent) {
          context.report({
            node,
            messageId: "inside",
            data: { parent },
            fix: (fixer) => fixSize(attr, `size-${value}`, fixer),
          })
          return
        }
        if (ICON_SCALE.has(`size-${value}`)) continue
        context.report({ node, messageId: "outside", data: { value } })
      }
    }
    return {
      JSXOpeningElement: check,
    }
  },
}

export const avatarFallbackSizes = {
  meta: {
    type: "problem",
    fixable: "code",
    docs: {
      description: "Avatar initials use text-xs at every avatar size.",
    },
    schema: [],
    messages: {
      size: "AvatarFallback uses text-xs so initials match across avatar sizes.",
    },
  },
  create(context) {
    const token = () =>
      /(^|\s)[-!]?(text-(?:xs|sm|base|lg|xl|[2-9]xl|\[[^\]]+\]))(?=\s|$)/g
    return {
      JSXOpeningElement(node) {
        if (jsxTagName(node.name) !== "AvatarFallback") return
        const attr = node.attributes.find(
          (candidate) =>
            attrName(candidate) === "className" ||
            attrName(candidate) === "class"
        )
        const texts = classStrings(node).join(" ")
        const sizes = texts.match(token())
        if (sizes?.length === 1 && /\btext-xs\b/.test(texts)) return
        context.report({
          node,
          messageId: "size",
          fix: (fixer) => {
            if (!attr) {
              return fixer.insertTextAfter(node.name, ' className="text-xs"')
            }
            if (
              attr.value?.type !== "Literal" ||
              typeof attr.value.value !== "string"
            ) {
              return null
            }
            let next = attr.value.value.replace(token(), "$1text-xs")
            if (!/\btext-xs\b/.test(next)) next = `${next} text-xs`
            next = next.trim().replace(/\s+/g, " ")
            return fixer.replaceText(attr.value, JSON.stringify(next))
          },
        })
      },
    }
  },
}

// Every avatar declares its size at the call site. There are two ways, and
// they are mutually exclusive:
//
// - a literal tier: size="default" | "sm" | "lg" (32/24/40px)
// - one icon-scale class: size-3 / size-4 / size-5 / size-6 (12/16/20/24px),
//   for rows smaller than the smallest tier — the properties row is 28px tall
//   with 14-16px icons, and the design system has no 16px tier.
//
// Leaving both out silently renders 32px, and the initials, presence badge and
// ring are sized from `data-size` on the root, so the box and its parts drift.
//
// The two cannot be combined. The tiers render `data-[size=sm]:size-6`, an
// attribute selector with specificity (0,2,0), which outranks a plain `size-4`
// (0,1,0): `size="sm" className="size-4"` renders 24px, not 16px. A class next
// to a tier looks like it does something and never does, so it is reported.
//
// `size={expr}` is reported too: a size picked at runtime is exactly the case
// review cannot check. Positioning classes (absolute, -right-1, after:hidden)
// stay allowed — the corner mark legitimately needs them (ORV-283).
//
// A size named in a local `const` is read branch by branch, so
// `const slotSize = showName ? "size-4" : "size-5"` passes: both branches are
// on the scale. A branch that is a runtime value is reported like `size={expr}`.
const AVATAR_TIERS = new Set(["default", "sm", "lg"])
const AVATAR_ICON_SCALE = new Set(["size-3", "size-4", "size-5", "size-6"])
const AVATAR_SIZE_TOKEN =
  /(?:^|[\s"'`])(?:[a-z0-9-]+:)*[-!]?size-(\[[^\]]+\]|[0-9.]+)(?=$|[\s"'`])/g
const AVATAR_WIDTH_TOKEN =
  /(?:^|[\s"'`])(?:[a-z0-9-]+:)*[-!]?(w-(?:\[[^\]]+\]|[0-9.]+))(?=$|[\s"'`])/
const AVATAR_HEIGHT_TOKEN =
  /(?:^|[\s"'`])(?:[a-z0-9-]+:)*[-!]?(h-(?:\[[^\]]+\]|[0-9.]+))(?=$|[\s"'`])/

export const avatarSizes = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Avatar declares its size explicitly: a literal tier or an icon-scale class.",
    },
    schema: [],
    messages: {
      missing:
        'Avatar needs an explicit size: size="default" | "sm" | "lg", or one of size-3/4/5/6 (12/16/20/24) in className.',
      dynamic:
        'size={…} hides the avatar size from review. Write the literal tier (size="default" | "sm" | "lg") or an icon-scale class (size-3/4/5/6).',
      unreadable:
        "The avatar size in className is only known at runtime, so review cannot check it. Pass a literal string, or a const whose every branch is a literal.",
      invalidTier:
        'size="{{value}}" is not an avatar tier. Use "default" (32px), "sm" (24px) or "lg" (40px).',
      conflict:
        'size="{{value}}" and {{cls}} both set the avatar size. The tier renders data-[size={{value}}]:size-* (specificity 0,2,0), which outranks the plain class, so {{cls}} never applies. Keep one.',
      offScale:
        "{{cls}} is off the avatar scale. Use size-3/4/5/6 (12/16/20/24), or a literal tier.",
      pair: "className sizes the avatar with w-*/h-* ({{cls}}). Use a literal tier or an icon-scale size-3/4/5/6 class.",
      multiple:
        "className carries more than one avatar size ({{cls}}). Keep exactly one of size-3/4/5/6.",
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (jsxTagName(node.name) !== "Avatar") return
        const sizeAttr = node.attributes.find(
          (candidate) => attrName(candidate) === "size"
        )

        // Each outcome is one way the element can render: `cn("shrink-0",
        // showName ? "size-4" : "size-5")` gives two, and each stands on its
        // own. A `null` outcome is one the rule cannot read.
        let unreadable = false
        const outcomes = []
        for (const group of classOutcomes(node, context)) {
          if (group === null) {
            unreadable = true
            continue
          }
          const text = group.join(" ")
          outcomes.push({
            tokens: [...text.matchAll(AVATAR_SIZE_TOKEN)].map((m) => m[1]),
            width: text.match(AVATAR_WIDTH_TOKEN),
            height: text.match(AVATAR_HEIGHT_TOKEN),
          })
        }

        // An arbitrary or off-scale value is a hand-picked size; say that
        // first, before judging whether a tier is also present.
        for (const outcome of outcomes) {
          const offScale = outcome.tokens.find(
            (value) => !AVATAR_ICON_SCALE.has(`size-${value}`)
          )
          if (offScale !== undefined) {
            context.report({
              node,
              messageId: "offScale",
              data: { cls: `size-${offScale}` },
            })
            return
          }
          if (outcome.width && outcome.height) {
            context.report({
              node,
              messageId: "pair",
              data: { cls: `${outcome.width[1]} ${outcome.height[1]}` },
            })
            return
          }
          if (outcome.tokens.length > 1) {
            context.report({
              node,
              messageId: "multiple",
              data: {
                cls: outcome.tokens.map((value) => `size-${value}`).join(" "),
              },
            })
            return
          }
        }

        const tier = sizeAttr ? staticString(sizeAttr) : null
        if (sizeAttr && tier === null) {
          context.report({ node: sizeAttr, messageId: "dynamic" })
          return
        }
        if (tier !== null && !AVATAR_TIERS.has(tier)) {
          context.report({
            node: sizeAttr,
            messageId: "invalidTier",
            data: { value: tier },
          })
          return
        }
        const iconClass = outcomes.find((outcome) => outcome.tokens.length > 0)
        if (tier !== null && iconClass) {
          context.report({
            node: sizeAttr,
            messageId: "conflict",
            data: { value: tier, cls: `size-${iconClass.tokens[0]}` },
          })
          return
        }
        // A declared tier already states the size. An unreadable className
        // next to it is a positioning passthrough, so there is nothing left
        // to check.
        if (tier !== null) return
        if (unreadable) {
          context.report({ node, messageId: "unreadable" })
          return
        }
        if (!iconClass) context.report({ node, messageId: "missing" })
      },
    }
  },
}

// Inline <svg> draws an icon by hand. Icons come from the icon library; a
// decorative inline SVG is at least hidden from assistive tech, and brand
// marks live in packages/ui/src/components/svgs (ORV-283).
export const inlineSvgs = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Inline <svg> icons belong in the icon library; mark decorative SVGs aria-hidden.",
    },
    schema: [],
    messages: {
      svg: "<svg> without aria-hidden renders as content. Use the icon library (HugeiconsIcon) or move a brand mark to packages/ui/src/components/svgs.",
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (!isIntrinsic(node) || node.name.name !== "svg") return
        if (node.attributes.some((attr) => attrName(attr) === "aria-hidden"))
          return
        context.report({ node, messageId: "svg" })
      },
    }
  },
}

/**
 * One plugin object for every orvilo-ui rule. Flat config refuses two
 * different objects under the same plugin name, so the rule groups below
 * share this one and only choose which rules to enable.
 */
const ORVILO_UI_PLUGIN = {
  rules: {
    "no-handwritten-control": handwrittenControls,
    "no-static-inline-style": staticInlineStyles,
    "no-hardcoded-color": hardcodedColors,
    "no-handwritten-surface": handwrittenSurfaces,
    "no-arbitrary-text-size": arbitraryTextSizes,
    "no-icon-size": iconSizes,
    "no-avatar-text-size": avatarFallbackSizes,
    "no-avatar-size": avatarSizes,
    "no-semantic-role": semanticRoles,
    "no-native-title": nativeTitles,
    "no-link-button": linkAsButton,
    "no-inline-svg": inlineSvgs,
  },
}

/** The closed type, icon and avatar scale; these apply to every renderer file. */
export function typeScaleRules(files, ignores = []) {
  return {
    files,
    ignores,
    plugins: { "orvilo-ui": ORVILO_UI_PLUGIN },
    rules: {
      "orvilo-ui/no-arbitrary-text-size": "error",
      "orvilo-ui/no-icon-size": "error",
      "orvilo-ui/no-avatar-text-size": "error",
      "orvilo-ui/no-avatar-size": "error",
    },
  }
}

/** Applies the hand-written UI rules above (ADR 0014). */
export function noHandwrittenUi(files, ignores = []) {
  return {
    files,
    ignores,
    plugins: { "orvilo-ui": ORVILO_UI_PLUGIN },
    rules: {
      "orvilo-ui/no-handwritten-control": "error",
      "orvilo-ui/no-static-inline-style": "error",
      "orvilo-ui/no-hardcoded-color": "error",
      "orvilo-ui/no-handwritten-surface": "error",
      "orvilo-ui/no-semantic-role": "error",
      "orvilo-ui/no-native-title": "error",
      "orvilo-ui/no-link-button": "error",
      "orvilo-ui/no-inline-svg": "error",
    },
  }
}
