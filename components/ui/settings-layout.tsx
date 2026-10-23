import type { ComponentProps, ReactNode } from 'react'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from '@/components/ui/field'
import { cn } from '@/lib/utils'

export function SettingsContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('mx-auto flex w-full max-w-3xl flex-col gap-9 px-6 py-10 sm:px-10 sm:py-16', className)} {...props} />
}

export function SettingsGroup({ className, ...props }: ComponentProps<typeof FieldGroup>) {
  return <FieldGroup className={cn('gap-0 rounded-xl border bg-muted/30 px-5', className)} {...props} />
}

export function SettingsRow({ title, description, htmlFor, descriptionId, children, ...props }: Omit<ComponentProps<typeof Field>, 'title' | 'children'> & { title: string; description?: ReactNode; htmlFor?: string; descriptionId?: string; children: ReactNode }) {
  return <Field orientation="responsive" className="min-h-20 gap-4 py-5 @md/field-group:has-[>[data-slot=field-content]]:items-center" {...props}>
    <FieldContent className="min-w-0 gap-1">{htmlFor ? <FieldLabel htmlFor={htmlFor}>{title}</FieldLabel> : <FieldTitle>{title}</FieldTitle>}{description && <FieldDescription id={descriptionId}>{description}</FieldDescription>}</FieldContent>
    <div data-slot="settings-control" className="flex min-w-0 items-center gap-2 @md/field-group:shrink-0">{children}</div>
  </Field>
}
