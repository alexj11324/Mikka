'use client'
import { useTranslations } from 'next-intl'

import { useRef, useState, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { createWorkspace } from '@/app/actions/workspace'
import { workspaceSlug, workspaceSlugSuffix } from '@/lib/workspace-slug'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group'

export function CreateWorkspaceForm() {
  const i18nText = useTranslations();
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [slugSuffix] = useState(workspaceSlugSuffix)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current) return
    inFlight.current = true
    setPending(true)
    setError('')
    try {
      const result = await createWorkspace({ name: name.trim(), slug: slug.trim() })
      if (!result.ok) { setError(result.error); return }
      toast.success(i18nText("FeatureCopy.c_9023f815"))
      window.location.assign('/')
    } catch {
      setError(i18nText("FeatureCopy.c_3f765954"))
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }
  return <form onSubmit={submit} onKeyDown={event => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault() }} aria-busy={pending} className="flex flex-col gap-8">
    <FieldGroup className="gap-6">
      <Field>
        <FieldLabel htmlFor="workspace-name">{i18nText("FeatureCopy.c_3a0522a8")}</FieldLabel>
        <Input id="workspace-name" name="name" autoFocus autoComplete="organization" required maxLength={120} value={name} placeholder={i18nText("FeatureCopy.c_88f2a723")} disabled={pending} onChange={event => { const value = event.target.value; setName(value); setError(''); if (!slugEdited) setSlug(workspaceSlug(value, slugSuffix)) }} />
      </Field>
      <Field>
        <FieldLabel htmlFor="workspace-slug">{i18nText("FeatureCopy.c_c4726adf")}</FieldLabel>
        <InputGroup>
          <InputGroupInput id="workspace-slug" name="slug" value={slug} onChange={event => { setSlugEdited(true); setSlug(event.target.value.toLowerCase()); setError('') }} required minLength={3} maxLength={64} pattern="[a-z0-9]([a-z0-9\-]{1,62}[a-z0-9])" autoCapitalize="none" autoComplete="off" spellCheck={false} aria-describedby="workspace-slug-help" title={i18nText("FeatureCopy.c_15ee958d")} placeholder="design-team" disabled={pending} />
          <InputGroupAddon><InputGroupText>/w/</InputGroupText></InputGroupAddon>
        </InputGroup>
        <FieldDescription id="workspace-slug-help">{i18nText("FeatureCopy.c_5b6455fb")}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="workspace-region">{i18nText("FeatureCopy.c_4ba7a058")}</FieldLabel>
        <Input id="workspace-region" value={i18nText("FeatureCopy.c_a55213ee")} readOnly />
      </Field>
    </FieldGroup>
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    <Button type="submit" size="lg" disabled={pending || !name.trim() || !slug.trim()}>{pending && <Loader2 className="animate-spin" data-icon="inline-start" />}{pending ? i18nText("Invite.creating") : i18nText("FeatureCopy.c_d92d1b8d")}</Button>
  </form>
}
