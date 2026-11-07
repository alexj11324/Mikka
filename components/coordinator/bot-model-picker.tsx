'use client'

// A bot's model chip is the model-picker slot (docs/ui-overlay.md).
export { BotModelPicker } from '@ui-slot/model-picker'
export { botModelMenuKey, openModelPicker } from '@/hooks/use-bot-model-picker'
export type { BotModelPickerProps } from '@/components/slots/model-picker-contract'
