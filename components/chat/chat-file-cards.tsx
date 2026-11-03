'use client'

import NextLink from 'next/link'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { AudioLines, Download, FileText, ImageIcon, RotateCw, X } from 'lucide-react'
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from '@/components/ui/attachment'
import { Spinner } from '@/components/ui/spinner'
import { withBasePath } from '@/lib/base-path'
import { cn } from '@/lib/utils'
import type { ChatFile } from '@mikka/protocol/chat-attachments'
import type { PendingChatFile } from './use-chat-files'

function FileCard({
  file,
  onRemove,
  sent,
}: {
  file: Pick<ChatFile, 'id' | 'name'>
  onRemove?: (id: string) => void
  sent?: boolean
}) {
  const t = useTranslations('Shell.attachments')
  const url = withBasePath(`/api/chat/attachments/${file.id}`)
  const { data } = useSWR<ChatFile>(`${url}?info`, async (path: string) => {
    const response = await fetch(path, { credentials: 'same-origin' })
    if (!response.ok) throw Error('file')
    return response.json()
  })
  const name = data?.name ?? file.name
  const icon = data?.mediaType.startsWith('image/') ? (
    <ImageIcon />
  ) : data?.mediaType.startsWith('audio/') ? (
    <AudioLines />
  ) : (
    <FileText />
  )
  return (
    <Attachment
      size="sm"
      className={cn('w-52 max-w-full flex-nowrap border-0', sent ? 'bg-card' : 'bg-control')}
      data-slot="chat-file-card"
    >
      <AttachmentMedia className="bg-transparent text-muted-foreground">{icon}</AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle title={name}>{name}</AttachmentTitle>
        <AttachmentDescription className="truncate">
          {data
            ? `${name.split('.').at(-1)?.toUpperCase()} · ${data.size < 1024 * 1024 ? `${Math.ceil(data.size / 1024)} KB` : `${(data.size / 1024 / 1024).toFixed(1)} MB`}`
            : t('loading')}
        </AttachmentDescription>
      </AttachmentContent>
      <AttachmentTrigger
        aria-label={t('open', { name })}
        render={<NextLink href={url} target="_blank" prefetch={false} />}
      />
      <AttachmentActions>
        {onRemove ? (
          <AttachmentAction
            type="button"
            className="pointer-coarse:size-11"
            aria-label={t('remove', { name })}
            onClick={() => onRemove(file.id)}
          >
            <X />
          </AttachmentAction>
        ) : (
          sent && (
            <AttachmentAction
              className="pointer-coarse:size-11"
              aria-label={t('download', { name })}
              render={<NextLink href={`${url}?download`} target="_blank" prefetch={false} />}
            >
              <Download />
            </AttachmentAction>
          )
        )}
      </AttachmentActions>
    </Attachment>
  )
}
function PopulatedChatFileCards({
  files,
  onRemove,
  pending = [],
  onRetry,
  sent = false,
}: {
  files: Pick<ChatFile, 'id' | 'name'>[]
  onRemove?: (id: string) => void
  pending?: PendingChatFile[]
  onRetry?: (file: PendingChatFile) => void
  sent?: boolean
}) {
  const t = useTranslations('Shell.attachments')
  const errorText = (code?: string) => {
    switch (code) {
      case 'unsupported':
        return t('errors.unsupported')
      case 'tooLarge':
        return t('errors.tooLarge')
      case 'unreadable':
        return t('errors.unreadable')
      case 'tooLong':
        return t('errors.tooLong')
      case 'tooMany':
        return t('errors.tooMany')
      case 'notFound':
        return t('errors.notFound')
      case 'audioKeyRequired':
        return t('errors.audioKeyRequired')
      default:
        return t('errors.unavailable')
    }
  }
  if (!files.length && !pending.length) return null
  return (
    <span className="flex min-w-0 max-w-full flex-wrap gap-2" data-slot="chat-file-cards">
      {files.map((file) => (
        <FileCard key={file.id} file={file} onRemove={onRemove} sent={sent} />
      ))}
      {pending.map((item) => (
        <Attachment
          key={item.key}
          size="sm"
          state={item.state === 'error' ? 'error' : item.state === 'processing' ? 'processing' : 'uploading'}
          className="w-52 max-w-full flex-nowrap border-0 bg-control"
          aria-busy={item.state !== 'error'}
        >
          <AttachmentMedia className="bg-transparent">
            {item.state === 'error' ? <FileText /> : <Spinner />}
          </AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle title={item.file.name}>{item.file.name}</AttachmentTitle>
            <AttachmentDescription className="truncate" role={item.state === 'error' ? 'alert' : 'status'}>
              {item.state === 'error'
                ? errorText(item.error)
                : item.state === 'processing'
                  ? t('processing')
                  : t('uploading', { percent: item.percent })}
            </AttachmentDescription>
          </AttachmentContent>
          <AttachmentActions>
            {item.state === 'error' && (
              <AttachmentAction
                type="button"
                className="pointer-coarse:size-11"
                aria-label={t('retry', { name: item.file.name })}
                onClick={() => onRetry?.(item)}
              >
                <RotateCw />
              </AttachmentAction>
            )}
            <AttachmentAction
              type="button"
              className="pointer-coarse:size-11"
              aria-label={t('remove', { name: item.file.name })}
              onClick={() => onRemove?.(item.key)}
            >
              <X />
            </AttachmentAction>
          </AttachmentActions>
        </Attachment>
      ))}
    </span>
  )
}

export function ChatFileCards(props: Parameters<typeof PopulatedChatFileCards>[0]) {
  if (!props.files.length && !props.pending?.length) return null
  return <PopulatedChatFileCards {...props} />
}
