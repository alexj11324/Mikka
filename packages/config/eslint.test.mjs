import assert from "node:assert/strict"
import { test } from "node:test"

import {
  noLegacyControlImports,
  noHandwrittenUi,
  noInertControls,
  noRawElements,
  typeScaleRules,
} from "./eslint.js"
import { Linter } from "eslint"
import tseslint from "typescript-eslint"

const FILE = "apps/desktop/src/renderer/x.tsx"

function lint(code, ignores = []) {
  const linter = new Linter({ configType: "flat" })
  return linter.verify(
    code,
    [
      { files: ["**/*.tsx"], languageOptions: { parser: tseslint.parser } },
      noRawElements(["apps/desktop/src/renderer/**/*.tsx"], ignores),
    ],
    FILE
  )
}

test("noRawElements 拦住有 @mikka/ui 对应组件的原生元素", () => {
  const messages = lint(
    "export const A = () => <aside><nav><button /><input /><table /><kbd /></nav></aside>"
  )
  assert.deepEqual(
    messages.map((m) => m.message.match(/<(\w+)>/)[1]),
    ["aside", "nav", "button", "input", "table", "kbd"]
  )
  assert.match(messages[2].message, /use @mikka\/ui Button/)
})

test("noRawElements 放行组件和普通元素，legacy 文件不检查", () => {
  assert.deepEqual(
    lint("export const A = () => <div><Button /><span /></div>"),
    []
  )
  assert.deepEqual(lint("export const A = () => <button />", [FILE]), [])
})

test("noRawElements 放行 render 里的语义宿主，但原生表单控件仍然报错", () => {
  assert.deepEqual(
    lint('export const A = () => <Button render={<a href="/x" />}>x</Button>'),
    []
  )
  assert.equal(
    lint(
      'export const A = () => <Item render={<button type="button" />}>x</Item>'
    ).length,
    1
  )
  assert.equal(
    lint('export const A = () => <div><button type="button">x</button></div>')
      .length,
    1
  )
})

function lintImports(code, ignores = []) {
  const linter = new Linter({ configType: "flat" })
  return linter.verify(
    code,
    [
      { files: ["**/*.tsx"], languageOptions: { parser: tseslint.parser } },
      noLegacyControlImports(["apps/desktop/src/renderer/**/*.tsx"], ignores),
    ],
    FILE
  )
}

test("noLegacyControlImports 禁止 Radix、tailwindcss-animate 和 旧 `components/ui`", () => {
  const samples = [
    'import { Slot } from "@radix-ui/react-slot"',
    'import "tailwindcss-animate"',
    'import { Button } from "@/components/ui/button"',
    'import { Button } from "../../ui/button"',
    'import { Button } from "../../components/ui/button"',
    'export { Button } from "@/components/ui/button"',
  ]
  for (const code of samples) {
    const messages = lintImports(code)
    assert.equal(messages.length, 1, code)
    assert.match(messages[0].message, /use @mikka\/ui/)
  }
})

test("noLegacyControlImports 放行 @mikka/ui 和 data-table-filter 的 ui", () => {
  assert.deepEqual(
    lintImports(
      'import { Button } from "@mikka/ui/components/ui/button"\nimport { DebouncedInput } from "../ui/debounced-input"'
    ),
    []
  )
  assert.deepEqual(
    lintImports('import { Button } from "@/components/ui/button"', [FILE]),
    []
  )
})

function lintInert(code, allowlist = null) {
  const linter = new Linter({ configType: "flat" })
  return linter.verify(
    code,
    [
      {
        files: ["**/*.tsx"],
        languageOptions: { parser: tseslint.parser },
      },
      noInertControls(["**/*.tsx"], allowlist),
    ],
    "apps/desktop/src/renderer/components/x.tsx"
  )
}

test("noInertControls 拦住没有动作的 Button 和空 onClick", () => {
  const messages = lintInert(`
    export const A = () => (
      <div>
        <Button>Save</Button>
        <button>Go</button>
        <Button onClick={() => {}}>Nope</Button>
        <div onClick={() => {}} />
      </div>
    )
  `)
  assert.deepEqual(
    messages.map((m) => m.messageId),
    ["inert", "inert", "empty", "empty"]
  )
})

test("noInertControls 放行动作属性和菜单触发器", () => {
  const messages = lintInert(`
    export const A = () => (
      <div>
        <Button onClick={() => save()}>Save</Button>
        <button type="submit">Go</button>
        <Button asChild><a href="/x">Open</a></Button>
        <DropdownMenuTrigger><Button>Menu</Button></DropdownMenuTrigger>
        <PopoverTrigger asChild><button>Pick</button></PopoverTrigger>
      </div>
    )
  `)
  assert.deepEqual(messages, [])
})

test("noInertControls 的 allowlist 只减不增", () => {
  const code = `export const A = () => <Button>Save</Button>`
  const key = "components/x.tsx"
  assert.deepEqual(lintInert(code, { [key]: { inert: 1, empty: 0 } }), [])
  assert.equal(
    lintInert(code, { [key]: { inert: 0, empty: 0 } })[0].messageId,
    "grew"
  )
  assert.equal(
    lintInert(code, { [key]: { inert: 2, empty: 0 } })[0].messageId,
    "shrink"
  )
})

function lintUi(code, ignores = []) {
  const linter = new Linter({ configType: "flat" })
  return linter
    .verify(
      code,
      [
        { files: ["**/*.tsx"], languageOptions: { parser: tseslint.parser } },
        noHandwrittenUi(["apps/desktop/src/renderer/**/*.tsx"], ignores),
      ],
      FILE
    )
    .map((m) => m.ruleId)
}

function verifyScale(code) {
  const linter = new Linter({ configType: "flat" })
  return linter.verify(
    code,
    [
      { files: ["**/*.tsx"], languageOptions: { parser: tseslint.parser } },
      typeScaleRules(["apps/desktop/src/renderer/**/*.tsx"]),
    ],
    FILE
  )
}

function lintScale(code) {
  return verifyScale(code).map((m) => m.ruleId)
}

test("no-handwritten-control 拦住普通元素上的点击/按键处理和交互 role", () => {
  assert.deepEqual(
    lintUi(
      'export const A = () => <div><span onClick={f} /><li onKeyDown={f} /><a onMouseDown={f} /><p role="button" /><section role="tab" /><div role="menuitem" /></div>'
    ),
    Array(6).fill("mikka-ui/no-handwritten-control")
  )
})

test("no-handwritten-control 放行组件、<a href>、label 和非交互 role", () => {
  assert.deepEqual(
    lintUi(
      'export const A = () => <div role="group"><Button onClick={f} /><a href="/x" onClick={f} /><label onClick={f} /><Item render={<a href="/y" />} /></div>'
    ),
    []
  )
})

test("no-static-inline-style 拦字面量视觉样式，放行计算值和 CSS 变量", () => {
  assert.deepEqual(
    lintUi(
      'export const A = () => <div style={{ color: "#fff", padding: 8, borderRadius: "4px", boxShadow: "0 0 1px red" }} />'
    ),
    Array(4).fill("mikka-ui/no-static-inline-style")
  )
  assert.deepEqual(
    lintUi(
      'export const A = () => <div style={{ backgroundColor: label.color, width: w, left: 0, top: `${y}px`, color: "var(--x)", "--sidebar-width": "16rem", paddingLeft: 24 + d * 20 }} />'
    ),
    []
  )
})

test("no-hardcoded-color 拦 className 里的 hex/rgb 色值", () => {
  // A literal colour on a plain element trips both rules: it is a hardcoded
  // colour and it is that element drawing its own surface.
  assert.deepEqual(
    lintUi(
      'export const A = () => <div><span className="bg-[#facc15]" /><span className={cn("x", ok && "text-[rgb(1,2,3)]")} /><span className="bg-primary text-muted-foreground" /></div>'
    ),
    [
      "mikka-ui/no-handwritten-surface",
      "mikka-ui/no-hardcoded-color",
      "mikka-ui/no-hardcoded-color",
      "mikka-ui/no-handwritten-surface",
    ]
  )
})

test("no-arbitrary-text-size 只放行 em/ex/ch 相对字号", () => {
  assert.deepEqual(
    lintScale(
      'export const A = () => <div><span className="text-[13px]" /><Badge className="text-[0.8rem]" /><span className="md:text-[11px]" /></div>'
    ),
    Array(3).fill("mikka-ui/no-arbitrary-text-size")
  )
  assert.deepEqual(
    lintScale(
      'export const A = () => <div><span className="text-xs" /><Badge className="text-sm text-muted-foreground" /><code className="text-[0.85em]" /><span className="text-[1.15em]" /></div>'
    ),
    []
  )
})

test("no-icon-size 组件内不放尺寸类，组件外只走 12/16/20/24", () => {
  assert.deepEqual(
    lintScale(
      'export const A = () => <Button><HugeiconsIcon icon={X} className="size-4" /></Button>'
    ),
    ["mikka-ui/no-icon-size"]
  )
  assert.deepEqual(
    lintScale(
      'export const A = () => <div><HugeiconsIcon icon={X} className="size-3.5" /></div>'
    ),
    ["mikka-ui/no-icon-size"]
  )
  assert.deepEqual(
    lintScale(
      'export const A = () => <div><HugeiconsIcon icon={X} className="size-4" /><span><HugeiconsIcon icon={Y} className="size-5" /></span></div>'
    ),
    []
  )
})

test("no-avatar-text-size 要求 AvatarFallback 用 text-xs", () => {
  assert.deepEqual(
    lintScale("export const A = () => <AvatarFallback>AB</AvatarFallback>"),
    ["mikka-ui/no-avatar-text-size"]
  )
  assert.deepEqual(
    lintScale(
      'export const A = () => <AvatarFallback className="text-sm">AB</AvatarFallback>'
    ),
    ["mikka-ui/no-avatar-text-size"]
  )
  assert.deepEqual(
    lintScale(
      'export const A = () => <AvatarFallback className="text-xs">AB</AvatarFallback>'
    ),
    []
  )
})

test("no-avatar-size 要求 Avatar 显式声明尺寸：字面量档位或图标尺度类", () => {
  // 档位：32 / 24 / 40。
  assert.deepEqual(
    lintScale(
      'export const A = () => <div><Avatar size="default" /><Avatar size="sm" /><Avatar size="lg" /></div>'
    ),
    []
  )
  // 小于最小档（24px）的行用图标尺度类，不带档位。
  assert.deepEqual(
    lintScale('export const A = () => <Avatar className="size-4" />'),
    []
  )
  // 定位类不是尺寸，放行。
  assert.deepEqual(
    lintScale(
      'export const A = () => <Avatar className="size-5 absolute -right-1 -bottom-1 after:hidden" />'
    ),
    []
  )
  // 档位和尺度类同时写：data-[size=sm]:size-6 的优先级更高，类永远不生效。
  assert.deepEqual(
    lintScale('export const A = () => <Avatar size="sm" className="size-4" />'),
    ["mikka-ui/no-avatar-size"]
  )
  // 都没写 = 隐式 32px。
  assert.deepEqual(lintScale("export const A = () => <Avatar />"), [
    "mikka-ui/no-avatar-size",
  ])
  // 运行时决定的尺寸没法在评审里核对。
  assert.deepEqual(lintScale("export const A = () => <Avatar size={tier} />"), [
    "mikka-ui/no-avatar-size",
  ])
  // 任意值、尺度外的值、以及 w-*/h-* 成对。
  assert.deepEqual(
    lintScale('export const A = () => <Avatar className="size-[18px]" />'),
    ["mikka-ui/no-avatar-size"]
  )
  assert.deepEqual(
    lintScale('export const A = () => <Avatar className="size-7" />'),
    ["mikka-ui/no-avatar-size"]
  )
  assert.deepEqual(
    lintScale('export const A = () => <Avatar className="h-5 w-5" />'),
    ["mikka-ui/no-avatar-size"]
  )
})

test("no-avatar-size 读得懂本地 const：每一支都按自己的结果判", () => {
  // 尺寸命名成 const、两支都在尺度上，是这条规则想要的写法。
  assert.deepEqual(
    lintScale(
      'export const A = ({ showName }) => { const slotSize = showName ? "size-4" : "size-5"; return <Avatar className={cn("shrink-0", slotSize)} /> }'
    ),
    []
  )
  // 一支出了尺度，仍然是手挑的尺寸。
  assert.deepEqual(
    lintScale(
      'export const A = ({ showName }) => { const slotSize = showName ? "size-4" : "size-7"; return <Avatar className={cn("shrink-0", slotSize)} /> }'
    ),
    ["mikka-ui/no-avatar-size"]
  )
  // 一支用 w-*/h-* 成对，也是同一个问题。
  assert.deepEqual(
    lintScale(
      'export const A = ({ showName }) => { const slotSize = showName ? "size-4" : "h-5 w-5"; return <Avatar className={cn("shrink-0", slotSize)} /> }'
    ),
    ["mikka-ui/no-avatar-size"]
  )
  // 读不出来的值（prop、import 进来再拼）在评审里看不见。
  assert.deepEqual(
    lintScale(
      'export const A = ({ unknownProp }) => <Avatar className={cn("shrink-0", unknownProp)} />'
    ),
    ["mikka-ui/no-avatar-size"]
  )
  assert.equal(
    verifyScale(
      'export const A = ({ unknownProp }) => <Avatar className={cn("shrink-0", unknownProp)} />'
    )[0].messageId,
    "unreadable"
  )
  // 同一支里两个尺度类。
  assert.deepEqual(
    lintScale(
      'export const A = ({ wide }) => { const slotSize = wide ? "size-4 size-5" : "size-4"; return <Avatar className={slotSize} /> }'
    ),
    ["mikka-ui/no-avatar-size"]
  )
  // 档位和某支里的尺度类同时出现，仍然是 conflict。
  assert.deepEqual(
    lintScale(
      'export const A = ({ showName }) => { const slotSize = showName ? "size-4" : "size-5"; return <Avatar size="sm" className={slotSize} /> }'
    ),
    ["mikka-ui/no-avatar-size"]
  )
  // 档位已经写死，className 只是调用方透传的定位类，不用再判。
  assert.deepEqual(
    lintScale(
      'export const A = ({ className }) => <Avatar size="sm" className={className} />'
    ),
    []
  )
})

test("no-semantic-role 拦住原生元素上的语义 role", () => {
  assert.deepEqual(
    lintUi(
      'export const A = () => <div><div role="table" /><div role="row" /><span role="gridcell" /><div role="columnheader" /><ul role="list"><li role="listitem" /></ul><div role="progressbar" /><hr role="separator" /><p role="alert" /><span role="status" /><div role="meter" /></div>'
    ),
    Array(11).fill("mikka-ui/no-semantic-role")
  )
})

test("no-semantic-role 放行组件、非语义 role 和动态 role", () => {
  assert.deepEqual(
    lintUi(
      'export const A = () => <div><div role="group" /><div role="presentation" /><div role={role} /><Table role="table" /><Progress role="progressbar" /></div>'
    ),
    []
  )
})

test("no-native-title 拦住原生元素上的 title", () => {
  assert.deepEqual(
    lintUi(
      'export const A = () => <div><span title="Save" /><button title={label} /><a href="/x" title="Open" /><div title={`Item ${n}`} /></div>'
    ),
    Array(4).fill("mikka-ui/no-native-title")
  )
})

test("no-native-title 放行组件上的 title", () => {
  assert.deepEqual(
    lintUi(
      'export const A = () => <div><Tooltip title="Save" /><Item title={t} /><span aria-label="Save" /></div>'
    ),
    []
  )
})

test("no-link-button 拦住画成按钮的链接", () => {
  assert.deepEqual(
    lintUi(
      'export const A = () => <div><a href="/x" className="rounded-md bg-primary">Go</a><Link to="/y" className={cn("border", x)} /><Link className={active && "hover:bg-accent"}>T</Link></div>'
    ),
    Array(3).fill("mikka-ui/no-link-button")
  )
})

test("no-link-button 放行纯文字链接和 Button render", () => {
  assert.deepEqual(
    lintUi(
      'export const A = () => <div><a href="/x" className="text-sm underline">Go</a><Link to="/y">T</Link><Button render={<Link to="/z" />} /></div>'
    ),
    []
  )
})

test("no-inline-svg 拦住没有 aria-hidden 的 svg", () => {
  assert.deepEqual(
    lintUi(
      'export const A = () => <div><svg viewBox="0 0 1 1" /><svg aria-hidden="true" /><svg aria-hidden={true} /><path d="M0 0" /></div>'
    ),
    ["mikka-ui/no-inline-svg"]
  )
})

test("noHandwrittenUi 的 ignores 放行图表、diff 和编辑器文件", () => {
  const code =
    'export const A = () => <div><svg viewBox="0 0 1 1" /><div role="table" /><span title="x" /><Link className="rounded-md" /></div>'
  assert.deepEqual(lintUi(code), [
    "mikka-ui/no-inline-svg",
    "mikka-ui/no-semantic-role",
    "mikka-ui/no-native-title",
    "mikka-ui/no-link-button",
  ])
  assert.deepEqual(lintUi(code, [FILE]), [])
})
