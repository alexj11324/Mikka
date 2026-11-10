// The default acceptance slot (docs/ui-overlay.md): none. 验收 on a task's page and the pane it opens keep the
// open-source view (components/workspace/factory-flow.tsx, factory-acceptance.tsx, factory-acceptance-pane.tsx);
// a layer that draws them exports components here.
import type { ComponentType } from 'react'
import type { AcceptanceFlowProps, AcceptancePaneProps, AcceptanceRowProps } from './acceptance-contract'

export const AcceptanceFlow: ComponentType<AcceptanceFlowProps> | null = null
export const AcceptanceRow: ComponentType<AcceptanceRowProps> | null = null
export const AcceptancePane: ComponentType<AcceptancePaneProps> | null = null
