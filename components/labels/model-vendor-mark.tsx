'use client'

import { KeyRound } from '@/components/icons'
import { vendorOf } from '@/lib/model-catalog'
import { modelDisplayName } from '@/lib/model-display-name'
import { ClaudeMark, OpenAIMark } from './brand-marks'
import { MODEL_VENDOR_MARKS } from './model-vendor-svgs'

const VENDOR_NAMES: Record<string, string> = {
  anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', deepseek: 'DeepSeek', moonshot: 'Moonshot AI', alibaba: 'Qwen',
  zhipu: 'Z.ai', mistral: 'Mistral', meta: 'Meta', xai: 'xAI', minimax: 'MiniMax',
}

/** Who makes a model, for a screen reader or a group heading: `deepseek/deepseek-v4-pro` → 「DeepSeek」. */
export function modelVendorName(model: string): string {
  const vendor = vendorOf(model)
  return VENDOR_NAMES[vendor] ?? (model.includes('/') ? model.split('/')[0] : modelDisplayName(model).name)
}

/**
 * A model's maker, by its id's vendor (decision 2026-11-15-1900): DeepSeek's
 * mark for `deepseek/…` whichever source runs it. A vendor without a mark
 * gets its initial on a tile.
 */
export function ModelVendorMark({ model }: { model: string }) {
  const vendor = vendorOf(model)
  const Mark = MODEL_VENDOR_MARKS[vendor]
  if (Mark) return <Mark aria-hidden="true" data-vendor={vendor} className="size-4 shrink-0" />
  const initial = (modelVendorName(model).trim().charAt(0) || '?').toUpperCase()
  return <span aria-hidden="true" data-vendor="other" className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm bg-muted text-xs font-semibold text-muted-foreground">{initial}</span>
}

/**
 * What pays for a model, as a small mark beside it: the subscription's
 * service, a key, or nothing on Mikka 额度.
 */
export function ModelSourceBadge({ kind, provider }: { kind: string; provider?: string }) {
  if (kind === 'subscription') {
    const Mark = provider === 'codex' ? OpenAIMark : ClaudeMark
    return <Mark aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
  }
  if (kind === 'apiKey' || kind === 'shared') return <KeyRound aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
  return null
}
