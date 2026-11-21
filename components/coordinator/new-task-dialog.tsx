'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from '@/lib/intl/i18n-client'
import useSWR from 'swr'
import { toast } from 'sonner'
import { listBots } from '@/app/actions/bots'
import { getNewTaskOptions } from '@/app/actions/issue-metadata'
import { useActionError } from '@/lib/use-action-error'
import { backlogTaskDraft } from '@/lib/task-create-form'
import { TASK_TITLE_MAX } from '@/lib/task-title-input'
import type { CreateAccess, CreateAssignee } from '@/lib/task-create-command'
import type { IssueLabel } from '@/lib/issue-metadata'
import { TEXT_ATTACHMENT_ACCEPT } from '@/lib/text-attachment'
import { TASK_FILE_MAX_BYTES, TASK_FILE_MAX_COUNT } from '@/lib/task-attachments/contract'
import { withBasePath } from '@/lib/base-path'
import { dueDatePresets } from '@/lib/task-due-presets'
import { AccessChangeDialog } from '@/components/workspace/issue-metadata-controls'
import { ISSUE_PRIORITIES, ISSUE_STATUSES, type IssueStatus } from '@/components/workspace/issue-properties'
import { TaskStatusIcon, useTaskStatusLabel } from '@/components/workspace/task-state-icon'
import { PriorityIcon } from '@/components/workspace/priority-icon'
import { PersonAvatar } from '@/components/person-avatar'
import { BotAvatar } from '@/components/nav/bot-avatar'
import { Button } from '@/components/ui/button'
import { newTaskBotChoices } from '@/lib/new-task-bot'
import { usePersonalProjectPicker } from './personal-project-picker'
import { useTaskDictation } from './use-task-dictation'
import { NewTask } from '@ui-slot/new-task'
import { TaskWorkspace } from '@ui-slot/task-workspace'
import { useTaskWorkspace } from '@/hooks/use-task-workspace'
import type { NewTaskProps } from '@/components/slots/new-task-contract'

const MAX_LENGTH = 8000
/** The task's short title column. */
const TITLE_MAX = TASK_TITLE_MAX

type Priority = (typeof ISSUE_PRIORITIES)[number]['value']

/** The picked Assignee choice's `value` (`user:<id>` / `bot:<id>`) as the create command carries it. */
function assigneeOf(value: string | null): CreateAssignee | null {
  const [kind, ...rest] = value?.split(':') ?? []
  const id = rest.join(':')
  return (kind === 'user' || kind === 'bot') && id ? { kind, id } : null
}

/**
 * 新建任务, Capy's way (decision 2026-11-19-2110): the window only registers a task, with its title, description,
 * Status, Priority, Assignee, Due date, Labels, Access, files and 语音; nothing is dispatched. Assigning a Bot wakes it
 * in its own chat and the Bot decides whether to start work; a person starts work themselves from the task's Start work.
 * A UI layer's new-task slot draws the window (docs/ui-overlay.md); the data, state and sending stay here.
 */
export function NewTaskDialog({ open, onOpenChange, project: pageProject, projectId: pageProjectId, readerId, workspaceId, teamId, onCreated, onAdded, initialBotId, initialText = '' }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (taskId: string) => void
  /** 继续新建: a task was created and the window stays; the page re-reads the task lists it shows (onCreated is not called). */
  onAdded?: () => void
  /** Opened from a Bot's chat: the task is assigned to that Bot, which wakes it. */
  initialBotId?: string
  /** Project page the request came from. */
  project?: string | null
  projectId?: string
  readerId?: string
  workspaceId?: string
  teamId?: string
  /** Keys typed before the dialog finished opening. */
  initialText?: string
}) {
  const t = useTranslations('Shell.newTaskDialog')
  const tCommon = useTranslations('Common')
  const tIssue = useTranslations('Issue')
  const projectPicker = usePersonalProjectPicker(open && !pageProjectId ? readerId : undefined, workspaceId)
  const projectId = pageProjectId ?? projectPicker.project?.id
  const project = pageProjectId ? pageProject : projectPicker.project?.name
  const tBoard = useTranslations('Shell.board')
  const actionError = useActionError()
  const pending = useRef(false)
  const createRequests = useRef(new Map<string, string>())
  const [draft, setDraft] = useState('')
  // 标题: required (Create only stays disabled without it); the task gets exactly what the person wrote.
  const [title, setTitle] = useState('')
  const [sending, setSending] = useState(false)
  // 继续新建: after a create the window stays, cleared, for the next one.
  const [more, setMore] = useState(false)
  // 状态 and Priority: Todo and Normal by default, as the board's backlog entry has them.
  const [status, setStatus] = useState<IssueStatus>('todo')
  const [priority, setPriority] = useState<Priority>('normal')
  const statusLabel = useTaskStatusLabel()
  const [assignee, setAssignee] = useState<string | null>(initialBotId ? `bot:${initialBotId}` : null)
  const [dueDate, setDueDate] = useState<string | null>(null)
  const [labels, setLabels] = useState<IssueLabel[]>([])
  const [access, setAccess] = useState<'workspace' | 'members'>('workspace')
  const [accessMembers, setAccessMembers] = useState<string[]>([])
  const [files, setFiles] = useState<File[]>([])
  const [accessChange, setAccessChange] = useState<{ fingerprint: string; tasks: number } | null>(null)

  const { data: options } = useSWR(open && workspaceId ? ['new-task-options', workspaceId] : null, () => getNewTaskOptions(workspaceId!))
  // The task is created in the workspace shown now: the dialog's `workspaceId` prop is the captured target; the
  // account menu's fresh read must still confirm it before anything is sent (#1661, never a silent retarget).
  const target = useTaskWorkspace(workspaceId)
  const workspace = target.state.status === 'ready' ? target.state.workspace : null
  const { data: bots = [] } = useSWR(open ? 'bots' : null, listBots)
  const botChoices = newTaskBotChoices(bots)
  const dictation = useTaskDictation(text => setDraft(current => current.trim() ? `${current.trimEnd()}\n${text}` : text),
    failure => toast.error(t(`dictationFailed.${failure}`)))
  useEffect(() => { if (open && initialText) setDraft(current => current || initialText) }, [open, initialText])

  function attach(picked: File[]) {
    const next = [...files]
    for (const file of picked) {
      if (!file.size || file.size > TASK_FILE_MAX_BYTES || next.length >= TASK_FILE_MAX_COUNT) { toast.error(t('fileRejected', { name: file.name })); continue }
      next.push(file)
    }
    setFiles(next)
  }

  /** The task exists; its files go up through the task's own attachments route. A failed one leaves the task as is. */
  async function upload(taskId: string, pickedFiles: File[]) {
    for (const file of pickedFiles) {
      const body = new FormData()
      body.set('file', file)
      const response = await fetch(withBasePath(`/api/tasks/${encodeURIComponent(taskId)}/attachments?id=${crypto.randomUUID()}`), { method: 'POST', body }).catch(() => null)
      if (!response?.ok) toast.error(t('fileFailed', { name: file.name }))
    }
  }

  async function submit(confirmedFingerprint?: string) {
    const name = title.trim()
    const text = draft.trim() || name
    const accessCommand: CreateAccess | undefined = access === 'members' ? { kind: 'members', memberIds: accessMembers } : undefined
    const properties = { assignee: assigneeOf(assignee), dueDate, labels, access: accessCommand }
    const fingerprint = JSON.stringify([workspaceId, teamId, projectId, name, text, status, priority, properties])
    const confirmAccess = confirmedFingerprint === fingerprint
    if (!name || !workspaceId || pending.current || projectPicker.pending || dictation.state !== 'idle') return
    pending.current = true
    setSending(true)
    try {
      // One fresh read must confirm the captured workspace is still the one shown before anything is sent.
      const confirmed = await target.confirm(workspaceId)
      if (confirmed.status === 'mismatch') { toast.error(t('workspaceChanged')); return }
      if (confirmed.status !== 'ready') { toast.error(t('workspaceUnconfirmed'), { action: { label: tCommon('retry'), onClick: () => { void submit() } } }); return }
    } catch { toast.error(t('workspaceUnconfirmed')); return }
    try {
      const requestId = createRequests.current.get(fingerprint) ?? crypto.randomUUID()
      createRequests.current.set(fingerprint, requestId)
      const { createTaskOnly } = await import('@/app/actions/issues')
      const result = await createTaskOnly({ version: 1, intent: 'create_only', workspaceId, requestId, ...(teamId ? { teamId } : {}), ...(projectId ? { projectId } : {}), ...(confirmAccess ? { confirmAccess: true } : {}),
        ...backlogTaskDraft(name, text, status), priority,
        ...(properties.assignee ? { assignee: properties.assignee } : {}), ...(dueDate ? { dueDate } : {}), ...(labels.length ? { labels } : {}), ...(accessCommand ? { access: accessCommand } : {}) })
      if (result.error && 'confirmable' in result && result.confirmable) { setAccessChange({ fingerprint, tasks: Number(result.params?.tasks ?? 1) }); return }
      // The server's trusted selection is no longer the captured one (a switch after the check): a mismatch refusal.
      if (result.error === 'workspaceAccessDenied') { toast.error(t('workspaceChanged')); return }
      if (result.error || !('taskId' in result)) { toast.error(actionError(result.error)); return }
      createRequests.current.delete(fingerprint)
      const pickedFiles = files
      setDraft('')
      setTitle('')
      setFiles([])
      await upload(result.taskId, pickedFiles)
      if (more) { toast.success(t('createdTask', { identifier: result.identifier })); onAdded?.(); return }
      onOpenChange(false)
      onCreated?.(result.taskId)
    } catch {
      toast.error(t('failed'))
    } finally {
      pending.current = false
      setSending(false)
    }
  }

  const TaskWindow = open ? NewTask : null
  if (open && !TaskWindow) throw new Error('Required product UI export missing: new-task.NewTask')
  // The window's context line: the Project the task goes to, and — when the page does not fix one — the Projects the
  // person may switch to. A workspace with nothing to choose shows no picker at all, and none of it gates submission.
  const projects = !pageProjectId && !projectPicker.error && projectPicker.data?.organizationId && projectPicker.data.projects.length
    ? { choices: projectPicker.data.projects.map(item => ({ value: item.id, label: item.name })), value: projectPicker.project?.id ?? '',
      onChange: (value: string) => { void projectPicker.choose(value || null) }, disabled: sending || projectPicker.pending, noneLabel: tBoard('noProject') }
    : undefined
  const statuses: NewTaskProps['status'] = { choices: ISSUE_STATUSES.map(item => ({ value: item.value, label: statusLabel(item.value), mark: <TaskStatusIcon status={item.value} /> })),
    value: status, onChange: value => setStatus(ISSUE_STATUSES.find(item => item.value === value)?.value ?? 'todo'), disabled: sending }
  const priorityLabel = (value: string) => tIssue.has(`priority.${value}` as never) ? tIssue(`priority.${value}` as never) : value
  const priorities: NewTaskProps['priority'] = { choices: ISSUE_PRIORITIES.map(item => ({ value: item.value, label: priorityLabel(item.value), mark: <PriorityIcon priority={item.value} /> })),
    value: priority, onChange: value => setPriority(ISSUE_PRIORITIES.find(item => item.value === value)?.value ?? 'normal'), disabled: sending }
  const members = options?.members ?? []
  const assignees: NewTaskProps['assignee'] = {
    choices: [
      ...members.map(person => ({ value: `user:${person.id}`, kind: 'user' as const, label: person.name, avatar: <PersonAvatar name={person.name} image={person.image} size="row" /> })),
      ...botChoices.map(bot => ({ value: `bot:${bot.id}`, kind: 'bot' as const, label: bot.name, avatar: <BotAvatar id={bot.id} color={bot.color} shape={bot.shape} size="row" /> })),
    ],
    value: assignee, onChange: setAssignee, disabled: sending,
  }
  const presets = dueDatePresets(new Date())
  const dates: NewTaskProps['dueDate'] = { value: dueDate, onChange: setDueDate, disabled: sending, presets: [
    { value: presets.today, label: t('due.today') }, { value: presets.tomorrow, label: t('due.tomorrow') },
    { value: presets.endOfWeek, label: t('due.endOfWeek') }, { value: presets.inOneWeek, label: t('due.inOneWeek') },
  ] }
  const knownLabels = [...new Map([...(options?.labels ?? []), ...labels].map(label => [label.name.toLowerCase(), label])).values()]
  const labelChoices: NewTaskProps['labels'] = { choices: knownLabels, value: labels.map(label => label.name), disabled: sending,
    onToggle: name => setLabels(current => current.some(label => label.name === name) ? current.filter(label => label.name !== name)
      : [...current, knownLabels.find(label => label.name === name) ?? { name, color: 'gray' as const }].slice(0, 12)),
    onCreate: name => { const value = name.trim().slice(0, 40); if (value && !labels.some(label => label.name.toLowerCase() === value.toLowerCase())) setLabels(current => [...current, { name: value, color: 'gray' as const }].slice(0, 12)) } }
  // Only specific people needs someone else to name: a personal space has only its owner.
  const others = members.filter(person => person.id !== options?.viewerId)
  const accessChoice: NewTaskProps['access'] = others.length ? { value: access, onChange: setAccess, workspaceLabel: t('accessWorkspace'), disabled: sending,
    members: others.map(person => ({ value: person.id, label: person.name, avatar: <PersonAvatar name={person.name} image={person.image} size="row" /> })),
    picked: accessMembers, onToggleMember: id => setAccessMembers(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]) } : undefined
  const fileList = files.length ? <ul className="flex flex-wrap gap-1.5">
    {files.map((file, index) => <li key={`${file.name}:${index}`} className="flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs">
      <span className="max-w-48 truncate">{file.name}</span>
      <Button type="button" variant="ghost" size="icon" className="size-5" aria-label={t('removeFile', { name: file.name })} disabled={sending}
        onClick={() => setFiles(current => current.filter((_, at) => at !== index))}>×</Button>
    </li>)}
  </ul> : null
  return <>
    {TaskWindow && <TaskWindow onClose={() => onOpenChange(false)} project={project} projects={projects} status={statuses} priority={priorities}
      assignee={assignees} dueDate={dates} labels={labelChoices} access={accessChoice}
      dictation={dictation.available ? { state: dictation.state, onStart: dictation.start, onStop: dictation.stop, disabled: sending } : undefined}
      title={title} onTitle={setTitle} titleMax={TITLE_MAX} text={draft} onText={setDraft} maxLength={MAX_LENGTH}
      files={fileList} onAttach={attach} accept={`${TEXT_ATTACHMENT_ACCEPT},image/*,application/pdf`}
      machines={[]} machine="auto" onMachine={() => {}} bots={[]} bot={null} onBot={() => {}}
      agent={{ value: null, choices: [], onChange: () => {}, disabled: true }}
      profile={{ choices: [], value: 'auto', label: '', onChange: () => {}, disabled: true }}
      intent="create_only" more={{ checked: more, onChange: setMore }} notices={<TaskWorkspace variant="create" workspace={workspace} state={target.state} onRetry={target.retry} />} sending={sending}
      canSubmit={!projectPicker.pending && Boolean(workspaceId) && !!title.trim() && dictation.state === 'idle' && workspace !== null}
      onSubmit={() => { void submit() }} />}
    {accessChange && <AccessChangeDialog change={accessChange} pending={sending} onCancel={() => setAccessChange(null)} onConfirm={async () => {
      const current = accessChange
      setAccessChange(null)
      await submit(current.fingerprint)
      return true
    }} />}
  </>
}
