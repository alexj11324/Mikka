import assert from 'node:assert/strict'
import test from 'node:test'
import { asyncPressBaseline, auditActionBindings, auditInteractions, staleBaselineEntries } from './interaction-policy.mjs'

const rules = source => auditInteractions('components/example.tsx', source).map(d => d.rule)

for (const [name, source] of [
  ['native working button', '<button onClick={save}>保存</button>'],
  ['native disabled button', '<button disabled onClick={save}>保存</button>'],
  ['button role on div', '<div role="button" onClick={save}>保存</div>'],
  ['clickable span', '<span onClick={save}>编辑</span>'],
  ['clickable div', '<div onClick={() => navigate(id)}>成员</div>'],
  ['composed native host', '<SidebarMenuSubButton render={<button type="button" />} onClick={navigate}>任务</SidebarMenuSubButton>'],
]) test(`requires Button component: ${name}`, () => assert.ok(rules(source).includes('interaction/use-button-component'), source))
for (const [name, source] of [
  ['missing action', '<Button>保存</Button>'],
  ['native missing action', '<button type="button">保存</button>'],
  ['disabled is not implementation', '<Button disabled>保存</Button>'],
  ['feature flag alone is not implementation', '<Button disabled data-feature-flag="mikka-upcoming-example">保存</Button>'],
  ['feature marked implemented still needs action', '<Button disabled data-feature-flag="mikka-upcoming-example" data-feature-implemented={true} aria-describedby="reason" title="尚未开放">保存</Button>'],
  ['empty callback', '<Button onClick={() => {}}>保存</Button>'],
  ['undefined callback', '<Button onClick={undefined}>保存</Button>'],
  ['returned undefined', '<Button onClick={() => undefined}>保存</Button>'],
  ['returned function without invocation', '<Button onClick={() => save}>保存</Button>'],
  ['returned method without invocation', '<Button onClick={() => actions.save}>保存</Button>'],
  ['empty resolved promise', '<Button onClick={() => Promise.resolve()}>保存</Button>'],
  ['event cancellation only', '<Button onClick={event => { event.preventDefault(); event.stopPropagation() }}>保存</Button>'],
  ['log only', '<Button onClick={() => console.log("save")}>保存</Button>'],
  ['toast-only warning without an operation', '<Button onClick={() => toast.warning("Try later")}>重试</Button>'],
  ['bare toast function without an operation', '<Button onClick={() => toast("Not saved")}>保存</Button>'],
  ['toast loading without starting any work', '<Button onClick={() => toast.loading("Working")}>重试</Button>'],
  ['toast message alone', '<Button onClick={() => toast.message("Coming later")}>连接</Button>'],
  ['custom notification without an operation', '<Button onClick={() => toast.custom(() => null)}>提交</Button>'],
  ['toast-only success bound to a named callback', 'const save = () => toast.success("Saved"); const ui = <Button onClick={save}>保存</Button>'],
  ['localized toast without an operation', '<Button onClick={() => toast.success(t("saved"))}>保存</Button>'],
  ['already-resolved value in a toast', '<Button onClick={async () => toast.success(await Promise.resolve("Saved"))}>保存</Button>'],
  ['native window alert without an operation', '<Button onClick={() => window.alert("Unavailable")}>连接</Button>'],
  ['global alert without an operation', '<Button onClick={() => alert("Not sent")}>发送</Button>'],
  ['named empty function', 'function save() {} const ui = <Button onClick={save}>保存</Button>'],
  ['aliased empty function', 'const save = () => {}; const click = save; const ui = <Button onClick={click}>保存</Button>'],
  ['wrapped empty function', 'function save() {} const ui = <Button onClick={() => save()}>保存</Button>'],
  ['placeholder message', '<Button onClick={() => toast.info("敬请期待")}>保存</Button>'],
  ['tooltip is not a button action', '<Tooltip><TooltipTrigger render={<Button>保存</Button>} /><TooltipContent>保存</TooltipContent></Tooltip>'],
  ['submit outside form', '<Button type="submit">保存</Button>'],
  ['submit without form action', '<form><Button type="submit">保存</Button></form>'],
  ['empty navigation', '<a href="">详情</a>'],
  ['hash placeholder', '<Link href="#">详情</Link>'],
  ['javascript placeholder', '<a href="javascript:void(0)">详情</a>'],
  ['menu missing action', '<DropdownMenuItem>导出</DropdownMenuItem>'],
  ['command missing action', '<CommandItem>打开</CommandItem>'],
  ['role button without action', '<div role="button" tabIndex={0}>打开</div>'],
  ['onSelect cannot implement a button click', '<Button onSelect={save}>保存</Button>'],
  ['onSubmit cannot implement a button click', '<Button onSubmit={save}>保存</Button>'],
  ['constant placeholder href', 'const target = "#"; const ui = <Link href={target}>详情</Link>'],
  ['aliased placeholder href', 'const target = "#"; const alias = target; const ui = <Link href={alias}>详情</Link>'],
  ['cyclic href aliases', 'const target = alias; const alias = target; const ui = <Link href={target}>详情</Link>'],
  ['object placeholder handler', 'const actions = { save: () => {} }; const ui = <Button onClick={actions.save}>保存</Button>'],
  ['object placeholder method', 'const actions = { save() {} }; const ui = <Button onClick={actions.save}>保存</Button>'],
  ['aliased button', 'import { Button as Save } from "@/components/ui/button"; const ui = <Save>保存</Save>'],
]) test(`rejects ${name}`, () => assert.ok(rules(source).length > 0, source))

for (const [name, source] of [
  ['explicit unimplemented feature presentation', '<Button disabled data-feature-flag="mikka-upcoming-example" data-feature-implemented={false} aria-describedby="reason" title="尚未开放">保存</Button>'],
  ['real callback', '<Button onClick={() => setOpen(true)}>打开</Button>'],
  ['forwarded callback', 'function Save({ onSave }) { return <Button onClick={onSave}>保存</Button> }'],
  ['async mutation', '<Button busy onClick={async () => { await saveIssue(data); await mutate() }}>保存</Button>'],
  ['mutation plus success feedback', '<Button onClick={() => { saveIssue(data); toast.success("Saved") }}>保存</Button>'],
  ['toast displaying the result of an awaited command', '<Button busy onClick={async () => toast.success(await submitTask())}>保存</Button>'],
  ['bare toast displaying an awaited command result', '<Button busy onClick={async () => toast(await submitTask())}>保存</Button>'],
  ['loading toast with an awaited command result', '<Button busy onClick={async () => toast.loading(await submitTask())}>保存</Button>'],
  ['async mutation plus refusal feedback', '<Button busy onClick={async () => { try { await saveIssue(data) } catch { toast.error("Failed") } }}>保存</Button>'],
  ['named mutation', 'async function save() { await saveIssue(data) } const ui = <Button busy onClick={save}>保存</Button>'],
  ['shadowed callback', 'const save = () => {}; function Editor() { const save = () => setOpen(true); return <Button onClick={save}>保存</Button> }'],
  ['cancel then act', '<Button onClick={event => { event.preventDefault(); saveIssue(data) }}>保存</Button>'],
  ['conditional action', '<Button onClick={() => { if (!pending) saveIssue(data) }}>保存</Button>'],
  ['menu trigger render composition', '<DropdownMenuTrigger render={<Button>菜单</Button>} />'],
  ['menu trigger child composition', '<DropdownMenuTrigger asChild><Button>菜单</Button></DropdownMenuTrigger>'],
  ['beUI morph popover trigger', '<MorphPopoverTrigger><Button type="button">添加</Button></MorphPopoverTrigger>'],
  ['beUI trigger stops row click', '<MorphPopoverTrigger><Button type="button" onClick={event => event.stopPropagation()}>菜单</Button></MorphPopoverTrigger>'],
  ['aliased beUI trigger', 'import { MorphPopoverTrigger as Trigger } from "@/components/motion/popover-morph"; const ui = <Trigger><Button>菜单</Button></Trigger>'],
  ['lucide Link icon', 'import { Link } from "lucide-react"; const ui = <Link />'],
  ['aliased lucide Link icon', 'import { Link as LinkIcon } from "lucide-react"; const ui = <LinkIcon />'],
  ['motion button forwarded callback', 'function Wrapper({ onClick, ...rest }) { return <Button onClick={onClick} {...rest}>保存</Button> }'],
  ['dialog cancel', '<DialogClose render={<Button>取消</Button>} />'],
  ['popover trigger', '<PopoverTrigger render={<Button>日期</Button>} />'],
  ['tooltip with real callback', '<TooltipTrigger render={<Button onClick={save}>保存</Button>} />'],
  ['real href', '<Link href="/issues">任务</Link>'],
  ['dynamic href', '<Link href={task.url}>任务</Link>'],
  ['guarded normalized href', 'const safeHref = href ? normalizeHref(href) : null; const ui = safeHref ? <Button render={<a href={safeHref} />}>链接</Button> : null'],
  ['conditional routes', '<Link href={registering ? "/sign-in" : "/sign-up"}>登录</Link>'],
  ['render host event delegation', '<SidebarMenuSubButton render={<Button type="button" variant="ghost" />} onClick={navigate}>任务</SidebarMenuSubButton>'],
  ['fragment target', '<a href="#description">描述</a>'],
  ['template URL', '<Link href={`/issues/${id}`}>详情</Link>'],
  ['aliased template URL', 'const href = `/issues/${id}`; const ui = <Button render={<Link href={href} />}>详情</Button>'],
  ['aliased settings URL', 'import { SettingsLink as Link } from "@/components/settings/settings-link"; const href = `/settings/teams?workspace=${id}`; const ui = <Button role="link" render={<Link href={href} />}>团队</Button>'],
  ['object action', 'const actions = { save: () => setOpen(true) }; const ui = <Button onClick={actions.save}>保存</Button>'],
  ['rendered navigation', '<Button render={<Link href="/issues" />}>任务</Button>'],
  ['form submit', '<form onSubmit={save}><Button type="submit">保存</Button></form>'],
  ['form server action', '<form action={saveAction}><Button type="submit">保存</Button></form>'],
  ['external form', '<><form id="edit" onSubmit={save} /><Button form="edit" type="submit">保存</Button></>'],
  ['button form action', '<Button type="submit" formAction={saveAction}>保存</Button>'],
  ['form reset', '<form><Button type="reset">重置</Button></form>'],
  ['menu selection', '<CommandItem onSelect={() => navigate(id)}>打开</CommandItem>'],
  ['noninteractive layout', '<div onClick={event => event.stopPropagation()}><span>任务</span></div>'],
]) test(`allows ${name}`, () => assert.deepEqual(rules(source), []))

const busy = 'interaction/async-press-needs-busy'
const busyRules = (source, baseline = {}) => auditInteractions('components/example.tsx', source, baseline)
const busyOnly = source => busyRules(source).map(diagnostic => diagnostic.rule)

for (const [name, source] of [
  ['inline async handler', '<Button onClick={async () => { await save() }}>保存</Button>'],
  ['named async function', 'async function save() { await saveIssue(data) } const ui = <Button onClick={save}>保存</Button>'],
  ['async arrow held in a const', 'const save = async () => { await saveIssue(data) }; const ui = <Button onClick={save}>保存</Button>'],
  ['handler that starts async work it never awaits', '<Button onClick={() => { items.forEach(async item => { await send(item) }) }}>发送</Button>'],
  ['async handler behind an alias', 'const save = async () => saveIssue(data); const click = save; const ui = <Button onClick={click}>保存</Button>'],
  ['async menu selection', '<CommandItem onSelect={async () => { await navigate(id) }}>打开</CommandItem>'],
]) test(`reports an async press without busy: ${name}`, () => assert.deepEqual(busyOnly(source), [busy], source))

for (const [name, source] of [
  ['busy passed', '<Button busy onClick={async () => { await save() }}>保存</Button>'],
  ['busy bound to the running state', '<Button busy={pending} onClick={async () => { await save() }}>保存</Button>'],
  ['spread may carry busy', '<Button {...rest} onClick={async () => { await save() }}>保存</Button>'],
  ['sync handler', '<Button onClick={() => setOpen(true)}>打开</Button>'],
  ['handler name the file never declares', '<Button onClick={save}>保存</Button>'],
  ['render host owns the press', '<SidebarMenuSubButton render={<Button type="button" />} onClick={async () => { await navigate() }}>任务</SidebarMenuSubButton>'],
  ['behavior trigger owns the press', '<PopoverTrigger render={<Button onClick={async () => { await open() }} />} />'],
]) test(`allows an async press that is already shown: ${name}`, () => assert.deepEqual(busyOnly(source), [], source))

test('a control that cannot take busy is told to become a Button', () => {
  const [diagnostic] = busyRules('<CommandItem onSelect={async () => { await navigate(id) }}>打开</CommandItem>')
  assert.match(diagnostic.message, /改用 `Button` 并传 `busy`/)
})

test('the baseline fails when a file holds more than it allows', () => {
  const two = 'const ui = <><Button onClick={async () => { await a() }}>A</Button><Button onClick={async () => { await b() }}>B</Button></>'
  assert.deepEqual(busyRules(two, { 'components/example.tsx': 2 }), [])
  const grown = busyRules(two, { 'components/example.tsx': 1 })
  assert.deepEqual(grown.map(diagnostic => diagnostic.rule), [busy])
  assert.match(grown[0].message, /baseline 只允许这个文件 1 处，现在 2 处/)
})

test('the baseline fails when it is slack, so the debt shrinks instead of freezing', () => {
  const one = '<Button onClick={async () => { await save() }}>保存</Button>'
  assert.deepEqual(busyRules(one, { 'components/example.tsx': 1 }), [])
  const slack = busyRules(one, { 'components/example.tsx': 3 })
  assert.deepEqual(slack.map(diagnostic => diagnostic.rule), [busy])
  assert.match(slack[0].message, /改成 1/)
  assert.match(busyRules('<Button onClick={save}>保存</Button>', { 'components/example.tsx': 2 })[0].message, /0 处就删掉这一行/)
})

test('the checked-in baseline still matches the tree', () => assert.deepEqual(staleBaselineEntries(), []))

test('a baseline row that no longer matches the tree is named', () => {
  assert.deepEqual(staleBaselineEntries({ 'components/gone.tsx': 1 }), ['components/gone.tsx: 文件不在了；删掉这一行'])
  assert.match(staleBaselineEntries({ 'components/ui/button.tsx': 1 })[0], /检查范围/)
  assert.match(staleBaselineEntries({ 'components/auth-form.tsx': 0 })[0], /大于 0 的整数/)
  const counted = asyncPressBaseline['components/auth-form.tsx']
  assert.match(staleBaselineEntries({ 'components/auth-form.tsx': counted + 3 })[0], new RegExp(`改成 ${counted}`))
})

const adapterRules = source => auditActionBindings('screen.tsx', source).map(diagnostic => diagnostic.rule)
const press = 'import { Pressable as Tap } from "react-native"; '

for (const [name, source, rule] of [
  ['native button without a press action', press + '<Tap accessibilityRole="button" />', 'interaction/no-dead-control'],
  ['a web click does not activate a native button', press + '<Tap accessibilityRole="button" onClick={save} />', 'interaction/no-dead-control'],
  ['named native no-op', press + 'const save = () => {}; const ui = <Tap onPress={save} />', 'interaction/no-placeholder-action'],
  ['toast-only adapter onPress', '<ActionRow onPress={() => toast.success("Saved")} />', 'interaction/no-placeholder-action'],
  ['native feedback alone', 'import { Alert as Dialog } from "react-native"; const ui = <ActionRow onPress={() => Dialog.alert("Saved")} />', 'interaction/no-placeholder-action'],
  ['official menu empty selection', '<ActionMenu onSelect={() => {}} />', 'interaction/no-placeholder-action'],
]) test(name, () => assert.ok(adapterRules(source).includes(rule)))

for (const [name, source] of [
  ['press delegates to command', press + '<Tap accessibilityRole="button" onPress={() => save(id)} />'],
  ['Expo link supplies press', press + 'import { Link } from "expo-router"; const ui = <Link asChild href="/edit"><Link.Trigger><Tap accessibilityRole="button" /></Link.Trigger></Link>'],
  ['forwarded native press props', press + '<Tap accessibilityRole="button" {...buttonProps} />'],
  ['pressable used for gesture input', press + '<Tap onPressIn={start} onPressOut={stop} />'],
  ['portal container absorbs clicks', '<div onClick={event => event.stopPropagation()} />'],
  ['paid button handled by the owning trigger', '<DialogTrigger asChild><button /></DialogTrigger>'],
  ['native confirmation with a button action', 'import { Alert } from "react-native"; const ui = <ActionRow onPress={() => Alert.alert("Delete?", "", [{ text: "Delete", onPress: remove }])} />'],
  ['read-only native summary', '<View><Text>Priority</Text></View>'],
]) test(name, () => assert.deepEqual(adapterRules(source), []))
