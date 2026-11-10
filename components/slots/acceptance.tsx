// The default acceptance slot (docs/ui-overlay.md): none. 验收 on a task's page keeps the open-source view
// (components/workspace/factory-flow.tsx, factory-acceptance.tsx); a layer that draws it as a short block exports
// `AcceptanceBlock` here.
import type { ComponentType } from 'react'
import type { AcceptanceBlockProps } from './acceptance-contract'

export const AcceptanceBlock: ComponentType<AcceptanceBlockProps> | null = null
