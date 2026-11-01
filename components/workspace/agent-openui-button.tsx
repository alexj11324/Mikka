'use client'

import { ACTION_STEPS, useFormName, useFormValidation, useIsStreaming, useTriggerAction, type ActionPlan } from '@openuidev/react-lang'
import { Button } from '@/components/ui/button'

type Props = { label?: string; action?: ActionPlan | { type?: string; params?: Record<string, unknown> }; variant?: 'primary' | 'secondary' | 'tertiary'; type?: 'normal' | 'destructive' }

const variants = { primary: 'default', secondary: 'secondary', tertiary: 'ghost' } as const

/**
 * OpenUI's `Button` (a Form's confirm button, for one) under its own name and
 * schema, drawn as the project Button at `sm` (8px radius, R-33) instead of
 * OpenUI's own. The click does what OpenUI's does: a primary button checks
 * the form first, then the action continues the chat.
 */
export function AgentOpenUIButton({ props }: { props: Props }) {
  const triggerAction = useTriggerAction()
  const formName = useFormName()
  const isStreaming = useIsStreaming()
  const formValidation = useFormValidation()
  const variant = props.variant ?? 'primary'
  const onClick = () => {
    const action = props.action
    if (formValidation && variant === 'primary') {
      const steps = action && 'steps' in action ? action.steps : undefined
      const needsValidation = steps
        ? steps.some(step => step.type === ACTION_STEPS.ToAssistant || step.type === 'custom_action' || (step.type === ACTION_STEPS.Run && 'refType' in step && step.refType === 'mutation'))
        : true
      if (needsValidation && !formValidation.validateForm()) return
    }
    void triggerAction(props.label ?? '', formName, action)
  }
  return <Button type="button" size="sm" variant={props.type === 'destructive' ? 'destructive' : variants[variant] ?? 'default'} disabled={isStreaming} onClick={onClick}>{props.label}</Button>
}
