'use client'

import { useTranslations } from 'next-intl'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Drawer, DrawerContent, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useIsMobile } from '@/hooks/use-mobile'
import { canSubmitReject, type RejectFlow } from '@/lib/factory/reject-flow'

type RejectNoteProps = { flow: RejectFlow; onEdit: (note: string) => void; onSubmit: () => void; onCancel: () => void }

/** The note sent with "request changes": a dialog on desktop (F5/F6), a bottom drawer on phones (M2). */
export function RejectNote(props: RejectNoteProps) {
  const t = useTranslations('FactoryAcceptance')
  const mobile = useIsMobile()
  const open = props.flow.phase !== 'closed'
  const close = (next: boolean) => { if (!next) props.onCancel() }
  if (mobile) return <Drawer open={open} onOpenChange={close}>
    <DrawerContent><DrawerHeader><DrawerTitle>{t('reject')}</DrawerTitle></DrawerHeader><RejectNoteBody {...props} mobile /></DrawerContent>
  </Drawer>
  return <Dialog open={open} onOpenChange={close}>
    <DialogContent showCloseButton={false}><DialogHeader><DialogTitle>{t('reject')}</DialogTitle></DialogHeader><RejectNoteBody {...props} mobile={false} /></DialogContent>
  </Dialog>
}

export function RejectNoteBody({ flow, onEdit, onSubmit, onCancel, mobile }: RejectNoteProps & { mobile: boolean }) {
  const t = useTranslations('FactoryAcceptance')
  const submitting = flow.phase === 'submitting'
  const failed = flow.phase === 'failed'
  const Footer = mobile ? DrawerFooter : DialogFooter
  const fields = <div className="flex flex-col gap-3">
    {failed && <div className="animate-in fade-in-0 slide-in-from-top-1 duration-150 motion-reduce:slide-in-from-top-0"><Alert variant="destructive"><AlertTitle>{t('rejectFailed')}</AlertTitle></Alert></div>}
    <Textarea aria-label={t('rejectNote')} value={flow.note} readOnly={submitting} onChange={event => onEdit(event.target.value)} />
  </div>
  return <>
    {mobile ? <div className="px-4">{fields}</div> : fields}
    <Footer>
      <Button variant="secondary" disabled={submitting} onClick={onCancel}>{t('cancel')}</Button>
      <Button disabled={submitting || !canSubmitReject(flow)} aria-busy={submitting} onClick={onSubmit}>
        {submitting && <Spinner data-icon="inline-start" />}{submitting ? t('rejecting') : failed ? t('resubmit') : t('rejectSubmit')}
      </Button>
    </Footer>
  </>
}
