'use client'

import { useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { createWorkspaceInvitation } from '@/app/actions/workspace'
import {
  InvitationCsvError,
  invitationEmails,
  MAX_INVITATION_CSV_BYTES,
  MAX_INVITATION_EMAILS,
  parseInvitationCsv,
  validateInvitationEmails,
} from '@/lib/invitation-csv'
import { useActionError } from '@/lib/use-action-error'
import { publicServiceLink } from '@/lib/platform/public-origin'

export type InviteLink = { email: string; url: string }
/** An address of the batch that got no link, and why (ALE-28). */
export type InviteSkip = { email: string; reason: 'alreadyMember' | 'duplicate' }

/**
 * 邀请成员 as data, for a UI layer that draws its own invite (slot `settings-members`): the same
 * emails, CSV import, role, invite links and copy as InviteMembersDialog. Nothing is emailed; the
 * links are handed over by hand and last 7 days.
 */
export function useInviteMembers(workspaceId: string | undefined, onCreated: () => Promise<unknown>) {
  const t = useTranslations('Invite')
  const format = useFormatter()
  const translateError = useActionError()
  const [emails, setEmailsValue] = useState('')
  const [role, setRole] = useState<'member' | 'admin'>('member')
  const [pending, setPending] = useState(false)
  const [importing, setImporting] = useState(false)
  const [fileName, setFileName] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [links, setLinks] = useState<InviteLink[]>([])
  const [skipped, setSkipped] = useState<InviteSkip[]>([])
  const recipients = invitationEmails(emails)
  const busy = pending || importing

  function csvErrorMessage(cause: unknown) {
    if (!(cause instanceof InvitationCsvError)) return t('errors.readFailed')
    switch (cause.code) {
      case 'emailRequired': return t('errors.emailRequired')
      case 'tooManyEmails': return t('errors.tooManyEmails', { max: cause.params.max ?? MAX_INVITATION_EMAILS, count: cause.params.count ?? 0 })
      case 'invalidEmails': return t('errors.invalidEmails', { emails: format.list(cause.params.emails ?? [], { type: 'conjunction' }) })
      case 'csvQuote': return t('errors.csvQuote', { line: cause.params.line ?? 0 })
      case 'csvUnclosedQuote': return t('errors.csvUnclosedQuote')
      case 'csvEmpty': return t('errors.csvEmpty')
      case 'csvMissingHeader': return t('errors.csvMissingHeader')
      case 'csvHeaderOnly': return t('errors.csvHeaderOnly')
      case 'csvInvalidRows': return t('errors.csvInvalidRows', { lines: format.list((cause.params.lines ?? []).map(String), { type: 'conjunction' }) })
      default: return t('errors.readFailed')
    }
  }

  function setEmails(value: string) {
    setEmailsValue(value); setError(''); setNotice(''); setFileName('')
  }

  /** Adds the emails of one .csv file (picked or dropped) to the ones typed. */
  async function importFile(files: File[]) {
    if (busy) return
    setError(''); setNotice('')
    if (files.length !== 1 || !files[0].name.toLowerCase().endsWith('.csv')) { setError(t('errors.notCsv')); return }
    const file = files[0]
    if (file.size > MAX_INVITATION_CSV_BYTES) { setError(t('errors.fileTooLarge')); return }
    setImporting(true)
    try {
      const parsed = parseInvitationCsv(await file.text())
      const merged = [...new Set([...recipients, ...parsed.emails])]
      validateInvitationEmails(merged)
      const duplicates = parsed.duplicates + recipients.length + parsed.emails.length - merged.length
      setEmailsValue(merged.join(', '))
      setFileName(file.name)
      setNotice(duplicates
        ? t('importedDuplicates', { count: parsed.emails.length, duplicates, total: merged.length })
        : t('imported', { count: parsed.emails.length, total: merged.length }))
    } catch (cause) {
      setError(csvErrorMessage(cause))
    } finally { setImporting(false) }
  }

  function clearImport() { setEmailsValue(''); setFileName(''); setNotice(''); setError('') }

  /** `replacing`: a renewal of one address, which keeps the batch it came from. */
  async function create(list: string[], asRole: 'member' | 'admin', replacing = false) {
    if (!workspaceId) return null
    const result = await createWorkspaceInvitation({ workspaceId, emails: list, role: asRole })
    if (!result.ok) { setError(translateError(result.error)); return null }
    const created = result.data.map(link => ({ email: link.email, url: publicServiceLink(link.path) }))
    if (!replacing) {
      setLinks(created)
      // One answer per address: a batch that skipped some still returns its links.
      setSkipped((result.outcomes ?? []).flatMap(outcome => outcome.created ? [] : [{ email: outcome.email, reason: outcome.reason }]))
    }
    try { await onCreated() } catch { setNotice(t('refreshFailed')) }
    return created
  }

  async function submit() {
    if (busy) return
    setError(''); setNotice('')
    try { validateInvitationEmails(recipients) } catch (cause) {
      setError(cause instanceof InvitationCsvError ? csvErrorMessage(cause) : t('errors.checkEmails'))
      return
    }
    setPending(true)
    try { await create(recipients, role) } catch { setError(t('errors.createFailed')) } finally { setPending(false) }
  }

  /** A pending invite again: the same email and role, a new link (the old one stops working) and 7 more days. */
  async function renew(email: string, asRole: 'member' | 'admin') {
    if (busy) return null
    setError(''); setNotice(''); setPending(true)
    try { return await create([email], asRole, true) } catch { setError(t('errors.createFailed')); return null } finally { setPending(false) }
  }

  async function copy(url: string) {
    try { await navigator.clipboard.writeText(url); setNotice(t('linkCopied')) } catch { setNotice(t('copyManually')) }
  }

  /** Back to an empty form once the links were handed out; a half-typed form is kept. */
  function reset() {
    setError(''); setNotice('')
    if (links.length || skipped.length) { setLinks([]); setSkipped([]); setEmailsValue(''); setFileName(''); setRole('member') }
  }

  return { emails, setEmails, recipients, role, setRole, pending, importing, busy, fileName, error, notice, links, skipped, importFile, clearImport, submit, renew, copy, reset }
}

export type InviteMembers = ReturnType<typeof useInviteMembers>
