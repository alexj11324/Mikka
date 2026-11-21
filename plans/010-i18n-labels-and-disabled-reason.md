# Plan 010: Translate the two hardcoded labels and explain the disabled reconnect

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result. On any STOP condition, stop and report.
>
> **Drift check (run first)**: `git diff --stat 89f5e7634..HEAD -- components/settings/api-key-settings.tsx components/settings/subscription-settings.tsx messages/zh-CN.json messages/en.json`
> On a mismatch with the excerpts, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: UX / i18n / rules compliance
- **Planned at**: commit `89f5e7634`, 2026-11-19

## Why this matters

Two user-visible defects in Settings, both one-line scale.

**1. Two labels are hardcoded English.** In the custom-provider dialog, every field is translated except two:

```tsx
// components/settings/api-key-settings.tsx:194
<FieldLabel htmlFor="api-key-base-url">Base URL</FieldLabel>
// components/settings/api-key-settings.tsx:211
<FieldLabel htmlFor="api-key-value">API Key</FieldLabel>
```

The Chinese UI therefore shows "Base URL" and "API Key" among 名称 / 协议 / 模型（可选）. `Settings.apiKeys.apiKey` **already exists** and is unused; `baseUrl` does not exist.

The root cause is in the checker: `scripts/check-i18n.mjs:209` returns early for any non-CJK text —

```js
const report = (node, text) => {
  if (!CJK.test(text)) return
```

— so hardcoded **English** passes CI silently. I verified: `findHardcodedText('x.tsx', '<div>Base URL</div>')` returns 0 hits, while `<div>基础地址</div>` returns 1.

> **Do not widen that gate in this plan.** A "no literal English in JSX" rule needs an allowlist for brand names, protocol names and identifiers; doing it here would either produce hundreds of false positives or ship a weakened rule. It is recorded as a separate follow-up in the maintenance notes.

**2. A disabled button has no stated reason (R-101).** `rules.md` R-101:

> A disabled control says why it cannot be pressed. … A control disabled because a field is still empty, or because a read is still in flight, needs no prose; one disabled by a permission, a plan, a missing connection or an owner does.

In `components/settings/subscription-settings.tsx:73`, the `unavailable` explanation is rendered **only when the provider has no connections**:

```tsx
{connections.length === 0 && <SettingRow … description={available ? undefined : t('unavailable')}>
```

So once a connection exists and the provider becomes unavailable, `:76`'s `disabled={!available …}` greys out "重新连接" with nothing on screen explaining it — exactly the case R-101 names.

## Current state

`components/settings/api-key-settings.tsx:190-212` (the `custom` block):
```tsx
<FieldLabel htmlFor="api-key-name">{t('name')}</FieldLabel>
…
<FieldLabel htmlFor="api-key-base-url">Base URL</FieldLabel>
<Input id="api-key-base-url" … placeholder="https://api.example.com/v1" … />
…
<FieldLabel htmlFor="api-key-value">API Key</FieldLabel>
```

Existing keys (`messages/zh-CN.json` / `en.json`, namespace `Settings.apiKeys`):
- `apiKey` → `"API Key"` / `"API key"` — **exists, unused here**
- `name` → `"名称"` / `"Name"`
- `protocolLabel` → `"协议"` / `"Protocol"`
- `models` → `"模型（可选）"` / `"Models (optional)"`
- `baseUrl` — **does not exist**

`components/settings/subscription-settings.tsx:64-78`:
```tsx
const available = state.providers.some(item => item.provider === provider && item.available)
…
{connections.length === 0 && <SettingRow … description={available ? undefined : t('unavailable')}>
…
{(reauth || !live || signingIn) && <SignInButton busy={signingIn} disabled={!canReconnect} … />}
```

`Settings.subscriptions.unavailable` → `"此连接暂不可用。"` / (en counterpart exists).

`components/ui/why-disabled.tsx` provides the R-101 wrapper (`title` for pointer, `aria-describedby` for screen readers).

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| i18n | `node scripts/check-i18n.mjs` | `i18n check passed` |
| Settings tests | `node --import tsx --test components/settings/subscription-settings.test.tsx` | pass |
| Provider routes | `node --import tsx --test components/settings/official-provider-routes.test.tsx` | pass |
| UI policy | `node scripts/lint-ui.mjs` | 0 errors |

## Scope

**In scope**:
- `components/settings/api-key-settings.tsx` — two labels
- `messages/zh-CN.json`, `messages/en.json` — add `Settings.apiKeys.baseUrl`
- `components/settings/subscription-settings.tsx` — wrap the reconnect button
- `components/settings/subscription-settings.test.tsx` — cover the disabled reason

**Out of scope**:
- `scripts/check-i18n.mjs` — see above; the English-literal gate is a separate piece of work.
- The other ~12 disabled-by-permission sites found in the audit. This plan fixes the one the rule's own source cites (a provider/connection becoming unavailable); a policy test is the follow-up.
- `.hosted-ui/**` — the private layer has its own `customUrl: 'Base URL'` at `lib/models/binding.tsx:167`; it is a separate repository and PR.

## Steps

### Step 1: Add the missing key

`messages/zh-CN.json`, under `Settings.apiKeys`:
```json
      "baseUrl": "Base URL",
```
`messages/en.json`, same place:
```json
      "baseUrl": "Base URL",
```

> Both locales use "Base URL" deliberately: it is the term the custom-provider form already uses as its placeholder (`https://api.example.com/v1`) and the protocol's own name. It is not an untranslated leftover — record that in the PR.

**Verify**: `node -e "const z=require('./messages/zh-CN.json');console.log(z.Settings.apiKeys.baseUrl)"` → `Base URL`.

### Step 2: Use the keys

`components/settings/api-key-settings.tsx:194`:
```tsx
<FieldLabel htmlFor="api-key-base-url">{t('baseUrl')}</FieldLabel>
```
`:211`:
```tsx
<FieldLabel htmlFor="api-key-value">{t('apiKey')}</FieldLabel>
```

**Verify**: `grep -n ">Base URL<\|>API Key<" components/settings/api-key-settings.tsx` → 0 hits.

### Step 3: Explain the disabled reconnect

In `components/settings/subscription-settings.tsx`, wrap the `SignInButton` at `:110` in `WhyDisabled`, passing a reason only when the provider is unavailable:

```tsx
{(reauth || !live || signingIn) && <WhyDisabled reason={available ? undefined : t('unavailable')}>
  <SignInButton busy={signingIn} disabled={!canReconnect} label={t(resumable ? 'resume' : 'reconnect')} busyLabel={t('connecting')} onClick={() => { void connect(provider, connection, resumable) }} />
</WhyDisabled>}
```

Add the import:
```tsx
import { WhyDisabled } from '@/components/ui/why-disabled'
```

`WhyDisabled` renders the children untouched when `reason` is undefined, so a busy or in-flight disabled state stays silent — which R-101 explicitly allows.

**Verify**: `grep -n "WhyDisabled" components/settings/subscription-settings.tsx` → import + one usage.

### Step 4: Cover it

In `components/settings/subscription-settings.test.tsx`, add a case: a connection exists and `providers` reports `available: false` → the reconnect button is disabled **and** the wrapper exposes the reason (`title` attribute equal to the `unavailable` copy, or the `aria-describedby` target contains it).

Model it on the existing cases in that file; reuse their fixture shape rather than inventing a new one.

**Verify**: the file passes.

### Step 5: Run the gates

```sh
node scripts/check-i18n.mjs
node --import tsx --test components/settings/subscription-settings.test.tsx
node --import tsx --test components/settings/official-provider-routes.test.tsx
node scripts/lint-ui.mjs
```

**Verify**: all pass; `0 errors`.

## Test plan

- **New**: unavailable provider + existing connection → disabled reconnect with a stated reason.
- **New (if the file has a harness)**: the custom-provider dialog renders `baseUrl`/`apiKey` from the catalog (so a missing key would fail rather than render the raw key name).
- **Must not regress**: the `connections.length === 0` row still shows `unavailable` as its description.

## Done criteria

- [ ] No literal `Base URL` / `API Key` JSX text in `api-key-settings.tsx`
- [ ] `Settings.apiKeys.baseUrl` exists in both locales
- [ ] The reconnect button is wrapped in `WhyDisabled` with an `available`-derived reason
- [ ] `node scripts/check-i18n.mjs` passes
- [ ] `subscription-settings.test.tsx` and `official-provider-routes.test.tsx` pass
- [ ] `node scripts/lint-ui.mjs` reports 0 errors

## STOP conditions

Stop and report if:
- `subscription-settings.test.tsx` has no harness that can render a connection with `available: false` (report rather than building one).
- Wrapping the button changes its DOM position in a way a test asserts (update the assertion, but say so).
- `WhyDisabled`'s `cloneElement` path warns about a fragment child — `SignInButton` renders a single `Button`, so it should not, but verify by running the test.

## Maintenance notes

- **Follow-up (not this plan): widen the i18n gate.** The correct shape is a JSX-text rule that fails on literal English longer than one word, with an explicit allowlist for protocol/brand names, and a frozen baseline like `scripts/mobile-i18n-baseline.mjs` uses for mobile. That is a policy change and needs its own review.
- **Follow-up (not this plan): an R-101 policy test.** The audit found 12 disabled-by-permission sites that do not use `WhyDisabled`. A `scripts/why-disabled-policy.mjs` in the style of `scripts/icon-button-policy.mjs` would catch them; writing the rule first is what makes the remaining fixes mechanical.
- The private `mikka-hosted-ui` layer has the same hardcoded `Base URL` at `lib/models/binding.tsx:167` and no i18n check script at all; that is a separate repository's PR.
