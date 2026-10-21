'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import { AspectRatio } from '@/components/motion/aspect-ratio'
import { ImageViewer, ImageViewerThumbnail, ImageViewerContent, ImageViewerCaption } from '@/components/motion/morphing-lightbox'
import type { AgentImageResult } from '@/lib/agent-images'

async function loadImage(url: string): Promise<{ image: AgentImageResult | null }> {
  const response = await fetch(url, { credentials: 'same-origin' })
  if (!response.ok) throw new Error('图片来源暂时不可用，正文不受影响。')
  return response.json()
}

export function AgentImage({ query, alt, caption, compact = false }: { query: string; alt: string; caption?: string; compact?: boolean }) {
  const { data, error, isLoading, mutate } = useSWR(`/api/agent/images?q=${encodeURIComponent(query)}`, loadImage, { revalidateOnFocus: false, shouldRetryOnError: false })
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  if (isLoading) return <figure className="flex min-w-0 flex-col gap-2" aria-busy="true" aria-label={alt}><Skeleton className="aspect-video w-full rounded-xl" /></figure>
  const image = data?.image
  if (error || (image && failedSrc === image.src)) return <Alert><AlertDescription>配图暂时无法加载。<Button type="button" variant="outline" size="sm" onClick={() => { setFailedSrc(null); void mutate() }}>重试配图</Button></AlertDescription></Alert>
  if (!image) return <p className="text-xs text-muted-foreground">未找到“{query}”的可用配图。</p>
  return <figure className="flex min-w-0 flex-col gap-2">
    <ImageViewer images={[{ id: image.source, src: image.src, alt, width: image.width, height: image.height, caption: caption ?? image.title }]} label="资料配图查看器">
      <AspectRatio ratio={16 / 9} animated={false} className="rounded-xl">
        <ImageViewerThumbnail imageId={image.source} aria-label={`放大查看：${alt}`} className="size-full rounded-none" imageClassName="size-full object-cover" onErrorCapture={() => setFailedSrc(image.src)} />
      </AspectRatio>
      <ImageViewerContent><ImageViewerCaption /></ImageViewerContent>
    </ImageViewer>
    <figcaption className="flex flex-col gap-1 text-xs text-muted-foreground">
      {caption && <span>{caption}</span>}
      {compact ? <Collapsible>
        <CollapsibleTrigger render={<Button type="button" variant="link" size="sm" />}>图片来源与许可</CollapsibleTrigger>
        <CollapsibleContent><a href={image.source} target="_blank" rel="noopener noreferrer" className="break-words underline underline-offset-4">Wikimedia Commons · {image.title}{image.author ? ` · ${image.author}` : ''} · {image.license}</a></CollapsibleContent>
      </Collapsible> : <a href={image.source} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">Wikimedia Commons · {image.title}{image.author ? ` · ${image.author}` : ''} · {image.license}</a>}
    </figcaption>
  </figure>
}
