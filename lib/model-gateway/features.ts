/*
 * Request features a custom endpoint can turn off (decision 2026-11-15-2000,
 * as Capy's connections do). The gateway removes them from a request before it
 * goes to a provider that rejects them. Pure: no server imports.
 */
import { z } from 'zod'

export const GATEWAY_FEATURES = ['strict', 'customTools', 'fallbacks', 'thinking'] as const
export type GatewayFeature = (typeof GATEWAY_FEATURES)[number]
/** Absent or true means on. */
export type GatewayFeatures = Partial<Record<GatewayFeature, boolean>>
export const gatewayFeaturesSchema = z.strictObject(Object.fromEntries(GATEWAY_FEATURES.map(feature => [feature, z.boolean().optional()])) as Record<GatewayFeature, z.ZodOptional<z.ZodBoolean>>)

export function parseGatewayFeatures(value: unknown): GatewayFeatures {
  const parsed = gatewayFeaturesSchema.safeParse(value ?? {})
  return parsed.success ? parsed.data : {}
}

type Body = Record<string, unknown>
const isObject = (value: unknown): value is Body => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * The request body with the turned-off features removed. `fallbacks` is a
 * routing preference and has no field in either protocol, so it changes nothing here.
 */
export function withoutDisabledFeatures(body: Body, features: GatewayFeatures): Body {
  const next: Body = { ...body }
  if (features.thinking === false) { delete next.thinking; delete next.reasoning }
  if (Array.isArray(next.tools)) {
    let tools = next.tools as unknown[]
    if (features.customTools === false) tools = tools.filter(tool => !isObject(tool) || tool.type !== 'custom')
    if (features.strict === false) tools = tools.map(tool => {
      if (!isObject(tool)) return tool
      const { strict: _strict, ...rest } = tool
      return isObject(rest.function) ? { ...rest, function: (({ strict: _inner, ...fn }) => fn)(rest.function) } : rest
    })
    next.tools = tools
  }
  return next
}
