import { useEffect, useRef, useState } from 'react'
import { AppState, Linking, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Button, FieldGroup, Host, ListItem, Picker, Text as NativeText, TextInput, useNativeState } from '@expo/ui'
import { NavBar } from '@/components/NavBar'
import { ReadNotice } from '@/components/ReadNotice'
import { Spinner } from '@/components/icons'
import { Text } from '@/components/Text'
import { CardButton } from '@/components/cards'
import { useSettings } from '@/lib/settings'
import { useApi } from '@/lib/useApi'
import { api, ApiError } from '@/lib/api'
import { apiCache } from '@/lib/api-cache'
import { mobileMessages as messages, mobileLocale } from '@/lib/messages'
import { colors } from '@/lib/theme'
import { billingManagementPath } from '../../../../../lib/billing/management-path'
import { budgetDraft, budgetInput, wholeNumber } from '../../../../../lib/billing/budget-draft'
import { receiptAmount } from '../../../../../lib/billing/presentation'
import type { BillingManagementOperation, BillingManagementView, BillingScope } from '../../../../../lib/billing/management-contract'
import type { ResourceBudgetView, BudgetScope, BudgetPeriod } from '../../../../../lib/billing/contract'

const copy = messages.Billing.management
const planCopy = messages.Settings.billing
const money = (micro: number) => new Intl.NumberFormat(mobileLocale, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(micro / 1_000_000)
const number = (value: number) => new Intl.NumberFormat(mobileLocale, { maximumFractionDigits: 4 }).format(value)
const errorText = (failure: unknown) => failure instanceof ApiError && failure.code in messages.Errors
  ? messages.Errors[failure.code as keyof typeof messages.Errors] : messages.Errors.generic

export default function BillingScreen() {
  const settings = useSettings(), router = useRouter()
  const scope = settings.data?.billingScope
  return <View style={{ flex: 1, backgroundColor: colors.grouped }}>
    <NavBar title={copy.billingEntry} background={colors.grouped} back={() => router.canGoBack() ? router.back() : router.replace('/settings')} />
    {scope ? <BillingContext key={`${scope.kind}:${scope.id}`} initial={scope} /> : <View style={{ padding: 16, gap: 12 }}>
      <ReadNotice error={settings.error} hasData={Boolean(settings.data)} label={copy.billingEntry} onRetry={settings.reload} />
      {settings.loading ? <Spinner /> : <Text>{messages.Errors.workspaceAccessDenied}</Text>}
    </View>}
  </View>
}

function BillingContext({ initial }: { initial: BillingScope }) {
  const [scope, setScope] = useState(initial), [workspace, setWorkspace] = useState<string | null>(null)
  const read = useApi<BillingManagementView>(billingManagementPath(scope, workspace))
  const [pending, setPending] = useState<BillingManagementOperation['action'] | null>(null), [failure, setFailure] = useState<string | null>(null)
  const alive = useRef(true), writing = useRef(false)
  const currentScope = useRef(scope), externalReturn = useRef(false)
  currentScope.current = scope
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    const listener = AppState.addEventListener('change', next => {
      if (next === 'active' && externalReturn.current) { externalReturn.current = false; void read.reload() }
    })
    return () => listener.remove()
  }, [read.reload])
  async function save(operation: BillingManagementOperation): Promise<boolean> {
    if (writing.current) return false
    writing.current = true; setPending(operation.action); setFailure(null)
    const context = apiCache.context()
    try {
      const pinned = ['checkout', 'portal', 'topup', 'recharge'].includes(operation.action) ? { ...operation, accountWorkspaceId: read.data?.account?.workspaceId } : operation
      const result = await api<{ url?: string }>(billingManagementPath(scope), { method: 'POST', body: pinned })
      if (!alive.current || context !== apiCache.context() || currentScope.current.kind !== scope.kind || currentScope.current.id !== scope.id) return false
      if (result.url) { externalReturn.current = true; await Linking.openURL(result.url) }
      else await read.reload()
      return true
    } catch (error) { if (alive.current && context === apiCache.context()) setFailure(errorText(error)); return false }
    finally { writing.current = false; if (alive.current && context === apiCache.context()) setPending(null) }
  }
  const denied = read.error instanceof ApiError && [401, 403].includes(read.error.status)
  if (!read.data || denied) return <View style={{ padding: 16, gap: 12 }}>
    {read.loading ? <Spinner /> : <><Text accessibilityRole="alert">{errorText(read.error)}</Text><CardButton label={messages.Common.retry} onPress={() => void read.reload()} /></>}
  </View>
  const data = read.data, busy = Boolean(pending), state = { data, pending, save }
  const workspaceChoices = data.scope.kind === 'workspace' ? [{ id: data.scope.id, name: data.scope.name }] : data.workspaces
  const plan = data.billing
  return <Host style={{ flex: 1 }} seedColor={colors.accent}>
    <FieldGroup>
      <FieldGroup.Section title={copy.scope}>
        <ListItem trailing={<Picker selectedValue={`${scope.kind}:${scope.id}`} enabled={!busy} onValueChange={value => {
          if (writing.current) return
          const [kind, id] = value.split(':'); if (kind === 'workspace' || kind === 'organization') { externalReturn.current = false; setScope({ kind, id }); setWorkspace(null); setFailure(null) }
        }}>
          {data.organizations.map(org => <Picker.Item key={org.id} value={`organization:${org.id}`} label={`${copy.organizationScope} · ${org.name}`} />)}
          {workspaceChoices.map(row => <Picker.Item key={row.id} value={`workspace:${row.id}`} label={`${copy.workspaceScope} · ${row.name}`} />)}
        </Picker>}><NativeText>{copy.scope}</NativeText></ListItem>
        <NativeText>{data.account ? copy.balanceAccount.replace('{name}', data.account.name) : copy.noAccount}</NativeText>
        <NativeText>{`${copy.activePlan}: ${copy.plans[data.capacity.plan]} · ${copy.capacity}: ${number(data.capacity.hostedMaxInFlight)}`}</NativeText>
        {!data.canPurchasePlatform && data.account ? <NativeText>{copy.differentPayer}</NativeText> : null}
        {read.error ? <NativeText textStyle={{ color: colors.danger }}>{errorText(read.error)}</NativeText> : null}
        {failure ? <NativeText textStyle={{ color: colors.danger }}>{failure}</NativeText> : null}
        <Button label={copy.reload} variant="text" disabled={busy || read.loading} onPress={() => void read.reload()} />
      </FieldGroup.Section>
      {data.organization ? <Account key={`${data.organization.id}:${data.organization.accountWorkspaceId}`} state={state} /> : null}
      {plan && <FieldGroup.Section title={planCopy.plan}>
        <ListItem supportingText={plan.billingModel === 'legacy_seat' ? planCopy.legacySubscription : copy.membersNotBilled} trailing={<NativeText>{number(plan.members)}</NativeText>}><NativeText>{plan.live ? plan.plan ?? planCopy.team : planCopy.free}</NativeText></ListItem>
        <ListItem trailing={<NativeText>{number(data.credits?.balancePoints ?? 0)}</NativeText>}><NativeText>{messages.Billing.balance.section}</NativeText></ListItem>
        {plan.planPoints !== null ? <ListItem trailing={<NativeText>{number(plan.planPoints)}</NativeText>}><NativeText>{planCopy.planPoints}</NativeText></ListItem> : null}
        <ListItem supportingText={planCopy.neverExpires} trailing={<NativeText>{number(plan.purchasedPoints)}</NativeText>}><NativeText>{planCopy.purchasedPoints}</NativeText></ListItem>
        {!plan.configured ? <NativeText>{messages.Errors.billingNotConfigured}</NativeText> : !data.canManagePayments ? <NativeText>{copy.readOnly}</NativeText> : <>
          {plan.hasCustomer ? <Button label={planCopy.managePayment} variant="outlined" disabled={busy} onPress={() => void save({ action: 'portal' })} /> : null}
          {!plan.live && data.canPurchasePlatform ? plan.resourceCheckoutAvailable ? <Button label={planCopy.subscribe} disabled={busy} onPress={() => void save({ action: 'checkout' })} /> : <NativeText>{copy.newSubscriptionUnavailable}</NativeText> : null}
          {data.canPurchasePlatform ? [10, 25, 50].map(amount => <Button key={amount} variant="outlined" disabled={busy} label={`${messages.Billing.balance.topUp} · ${money(amount * 1_000_000)} / ${number(amount * 100)} ${planCopy.points}`}
            onPress={() => void save({ action: 'topup', amount, locale: mobileLocale })} />) : null}
        </>}
      </FieldGroup.Section>}
      <FieldGroup.Section title={`${copy.usage} · ${data.usage.month}`}>
        <Metric label={copy.platformActual} value={money(data.usage.costMicroUsd)} />
        <Metric label={copy.platformReserved} value={money(data.usage.reservedMicroUsd)} />
        <Metric label={copy.platformUnknown} value={`${copy.unknown} · ${number(data.usage.unknownCalls)}`} />
        <Metric label={copy.externalUnknown} value={`${copy.unknown} · ${number(data.usage.externalUnknownRuns)}`} />
        <FieldGroup.SectionFooter><NativeText>{copy.unknownHelp}</NativeText></FieldGroup.SectionFooter>
      </FieldGroup.Section>
      <FieldGroup.Section title={copy.memberUsage}>
        {data.usage.members.length ? data.usage.members.map((row, index) => <ListItem key={row.id ?? index} supportingText={row.unknownCalls ? `${copy.unknown} · ${number(row.unknownCalls)}` : undefined} trailing={<NativeText>{money(row.costMicroUsd)}</NativeText>}><NativeText>{row.name ?? row.id ?? copy.unattributed}</NativeText></ListItem>) : <NativeText>{copy.noMemberUsage}</NativeText>}
      </FieldGroup.Section>
      <Budgets key={`${scope.kind}:${scope.id}:${data.budgetWorkspaceId}`} state={state} chooseWorkspace={setWorkspace} />
      {plan?.autoRecharge ? <Recharge key={`${data.account?.workspaceId}:${plan.autoRecharge.revision}`} state={state} /> : null}
      {data.credits && <FieldGroup.Section title={messages.Billing.balance.history}>
        {data.credits.transactions.length ? data.credits.transactions.map(row => <ListItem key={row.id} supportingText={`${new Intl.DateTimeFormat(mobileLocale, { timeZone: 'UTC' }).format(new Date(row.date))} · ${number(row.points)} ${planCopy.points}`}
          trailing={<NativeText>{receiptAmount(row.amountCents, row.currency, mobileLocale, copy.unknown)}</NativeText>}
          onPress={row.receiptUrl ? () => void Linking.openURL(row.receiptUrl!) : undefined}><NativeText>{messages.Billing.balance.types[row.type]}</NativeText></ListItem>) : <NativeText>{copy.historyEmpty}</NativeText>}
      </FieldGroup.Section>}
    </FieldGroup>
  </Host>
}

type State = { data: BillingManagementView; pending: BillingManagementOperation['action'] | null; save: (operation: BillingManagementOperation) => Promise<boolean> }
function Metric({ label, value }: { label: string; value: string }) {
  return <ListItem trailing={<NativeText>{value}</NativeText>}><NativeText>{label}</NativeText></ListItem>
}
function TextField({ label, value, onChange, disabled, numeric = false }: { label: string; value: string; onChange: (next: string) => void; disabled: boolean; numeric?: boolean }) {
  const native = useNativeState(value)
  useEffect(() => { native.set(value) }, [native, value])
  return <ListItem supportingText={label}><TextInput accessibilityLabel={label} value={native} inputMode={numeric ? 'numeric' : 'text'} autoCapitalize="none" autoCorrect={false} returnKeyType="done" editable={!disabled} onChangeText={onChange} /></ListItem>
}
function NumberField(props: { label: string; value: string; onChange: (next: string) => void; disabled: boolean }) {
  return <TextField {...props} numeric />
}
function Account({ state }: { state: State }) {
  const org = state.data.organization!, [selected, setSelected] = useState(org.accountWorkspaceId ?? 'none')
  return <FieldGroup.Section title={copy.account}>
    {org.canDesignate ? <>
      <ListItem trailing={<Picker selectedValue={selected} enabled={!state.pending} onValueChange={setSelected}>
        <Picker.Item value="none" label={copy.accountNone} />
        {org.accounts.filter(row => row.selectable || row.id === org.accountWorkspaceId).map(row => <Picker.Item key={row.id} value={row.id} label={row.name} />)}
      </Picker>}><NativeText>{copy.account}</NativeText></ListItem>
      <Button label={state.pending === 'account' ? copy.saving : copy.saveAccount} disabled={Boolean(state.pending) || selected === (org.accountWorkspaceId ?? 'none')}
        onPress={() => void state.save({ action: 'account', workspaceId: selected === 'none' ? null : selected })} />
    </> : <><NativeText>{org.accounts.find(row => row.id === org.accountWorkspaceId)?.name ?? copy.accountNone}</NativeText><NativeText>{copy.accountOwnerOnly}</NativeText></>}
    <FieldGroup.SectionFooter><NativeText>{copy.accountHelp}</NativeText></FieldGroup.SectionFooter>
  </FieldGroup.Section>
}
function Budgets({ state, chooseWorkspace }: { state: State; chooseWorkspace: (id: string) => void }) {
  const data = state.data, [editing, setEditing] = useState<ResourceBudgetView | undefined>()
  return <FieldGroup.Section title={copy.budgets}>
    {data.workspaces.length > 1 && <ListItem trailing={<Picker selectedValue={data.budgetWorkspaceId ?? ''} enabled={!state.pending} onValueChange={chooseWorkspace}>
      {data.workspaces.map(row => <Picker.Item key={row.id} value={row.id} label={row.name} />)}
    </Picker>}><NativeText>{copy.budgetWorkspace}</NativeText></ListItem>}
    {data.budgets.length ? data.budgets.map(row => <ListItem key={row.id} onPress={data.canManageBudget && !state.pending ? () => setEditing(row) : undefined}
      supportingText={`${copy.periods[row.period]} · ${row.scope === 'workspace' ? data.workspaces.find(ws => ws.id === row.workspaceId)?.name ?? row.workspaceId : data.members.find(member => member.id === row.scopeId)?.name ?? row.scopeId}\n${copy.budgetSpent}: ${number(row.spentPoints)} · ${copy.budgetReserved}: ${number(row.reservedPoints)} · ${copy.budgetRemaining}: ${number(row.remainingPoints)}\n${row.exhausted ? copy.budgetExhausted : row.thresholdReached ? copy.budgetThreshold : copy.budgetHealthy}`}
      trailing={<NativeText>{`${number(row.limitPoints)} · ${row.warningPercent}%`}</NativeText>}><NativeText>{copy.scopes[row.scope]}</NativeText></ListItem>) : <NativeText>{copy.noBudgets}</NativeText>}
    {data.canManageBudget && data.budgetWorkspaceId ? <>
      {editing ? <Button label={copy.budgetNew} variant="text" disabled={Boolean(state.pending)} onPress={() => setEditing(undefined)} /> : null}
      <BudgetForm key={editing?.id ?? 'new'} state={state} existing={editing} />
    </> : <NativeText>{copy.budgetReadOnly}</NativeText>}
  </FieldGroup.Section>
}
function BudgetForm({ state, existing }: { state: State; existing?: ResourceBudgetView }) {
  const data = state.data, workspaceId = data.budgetWorkspaceId!, busy = Boolean(state.pending)
  const [draft, setDraft] = useState(() => budgetDraft(workspaceId, existing)), [invalid, setInvalid] = useState(false), [saved, setSaved] = useState(false)
  const patch = (value: Partial<typeof draft>) => { setDraft(current => ({ ...current, ...value })); setSaved(false); setInvalid(false) }
  const choices = draft.scope === 'member' ? data.members.map(row => ({ id: row.id, label: row.name })) : data.resourceTargets.filter(row => row.kind === (draft.scope === 'project' ? 'project' : 'thread')).map(row => ({ id: row.id, label: `${row.id} · ${row.visibility}` }))
  if (draft.scopeId && draft.scope !== 'workspace' && !choices.some(row => row.id === draft.scopeId)) choices.unshift({ id: draft.scopeId, label: draft.scopeId })
  async function save(remove = false) {
    const value = budgetInput(draft, workspaceId, remove)
    if (!value) { setInvalid(true); return }
    setInvalid(false); setSaved(await state.save({ action: 'budget', workspaceId, budget: value }))
  }
  return <>
    <ListItem trailing={<Picker<BudgetScope> selectedValue={draft.scope} enabled={!busy && !existing} onValueChange={scope => patch({ scope, scopeId: scope === 'workspace' ? workspaceId : '' })}>
      {(['workspace', 'member', 'project', 'thread', 'run'] as const).filter(scope => data.resourceTargetsAvailable || scope === 'workspace' || scope === 'member').map(scope => <Picker.Item key={scope} value={scope} label={copy.scopes[scope]} />)}
    </Picker>}><NativeText>{copy.budgetScope}</NativeText></ListItem>
    <ListItem trailing={<Picker<BudgetPeriod> selectedValue={draft.period} enabled={!busy && !existing} onValueChange={period => patch({ period })}>
      {(['month', 'day', 'lifetime'] as const).map(period => <Picker.Item key={period} value={period} label={copy.periods[period]} />)}
    </Picker>}><NativeText>{copy.budgetPeriod}</NativeText></ListItem>
    {draft.scope !== 'workspace' ? <ListItem supportingText={!['member', 'workspace'].includes(draft.scope) ? copy.resourceIdHelp : undefined} trailing={<Picker selectedValue={draft.scopeId} enabled={!busy && !existing} onValueChange={scopeId => patch({ scopeId })}>
      <Picker.Item value="" label={copy.budgetTarget} />
      {choices.map(row => <Picker.Item key={row.id} value={row.id} label={row.label} />)}
    </Picker>}><NativeText>{copy.budgetTarget}</NativeText></ListItem> : null}
    {!['workspace', 'member'].includes(draft.scope) ? <TextField label={copy.resourceId} value={draft.scopeId} onChange={scopeId => patch({ scopeId })} disabled={busy || Boolean(existing)} /> : null}
    <NumberField label={copy.budgetLimit} value={draft.limit} onChange={limit => patch({ limit })} disabled={busy} />
    <NumberField label={copy.budgetWarning} value={draft.warning} onChange={warning => patch({ warning })} disabled={busy} />
    <NativeText>{copy.budgetLimitHint}</NativeText>
    {!data.resourceTargetsAvailable ? <NativeText>{copy.resourceUnavailable}</NativeText> : null}
    {invalid ? <NativeText textStyle={{ color: colors.danger }}>{copy.invalid}</NativeText> : null}
    <Button label={state.pending === 'budget' ? copy.saving : copy.budgetSave} disabled={busy} onPress={() => void save()} />
    {existing ? <Button label={copy.budgetRemove} variant="outlined" disabled={busy} onPress={() => void save(true)} /> : null}
    {existing ? <NativeText>{copy.removeLimitHelp}</NativeText> : null}
    {saved ? <NativeText>{copy.saved}</NativeText> : null}
  </>
}
function Recharge({ state }: { state: State }) {
  const policy = state.data.billing!.autoRecharge!, disabled = Boolean(state.pending) || !state.data.canManageRecharge
  const [threshold, setThreshold] = useState(String(policy.thresholdPoints ?? 200)), [amount, setAmount] = useState(policy.amountPoints ?? 1000), [cap, setCap] = useState(String(policy.monthlyCapPoints ?? 1000))
  const [invalid, setInvalid] = useState(false), [saved, setSaved] = useState(false)
  async function save() {
    const thresholdPoints = wholeNumber(threshold), monthlyCapPoints = wholeNumber(cap)
    if (thresholdPoints === null || monthlyCapPoints === null || thresholdPoints >= amount || monthlyCapPoints < amount) { setInvalid(true); return }
    setInvalid(false); setSaved(await state.save({ action: 'recharge', policy: { enabled: false, expectedRevision: policy.revision, thresholdPoints, amountPoints: amount as 1000 | 2500 | 5000, monthlyCapPoints } }))
  }
  return <FieldGroup.Section title={copy.recharge}>
    <NativeText>{copy.rechargeHelp}</NativeText>
    <NumberField label={copy.rechargeThreshold} value={threshold} onChange={setThreshold} disabled={disabled} />
    <ListItem trailing={<Picker selectedValue={amount} enabled={!disabled} onValueChange={setAmount}>{[1000, 2500, 5000].map(value => <Picker.Item key={value} value={value} label={number(value)} />)}</Picker>}><NativeText>{copy.rechargeAmount}</NativeText></ListItem>
    <NumberField label={copy.rechargeCap} value={cap} onChange={setCap} disabled={disabled} />
    {invalid ? <NativeText textStyle={{ color: colors.danger }}>{copy.invalid}</NativeText> : null}
    {state.data.canManageRecharge ? <Button label={state.pending === 'recharge' ? copy.saving : copy.rechargeSave} disabled={disabled} onPress={() => void save()} /> : <NativeText>{copy.rechargeOwnerOnly}</NativeText>}
    {saved ? <NativeText>{copy.saved}</NativeText> : null}
  </FieldGroup.Section>
}
