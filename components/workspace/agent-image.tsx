'use client'

import { useAgentCopy } from '@/hooks/use-agent-copy'
import { createContext, useContext, useState } from 'react'
import type { AgentImageResult } from '@/lib/agent-images'

import useSWR from 'swr'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import { AspectRatio } from '@/components/motion/aspect-ratio'
import { ImageViewer, ImageViewerThumbnail, ImageViewerContent, ImageViewerCaption } from '@/components/motion/morphing-lightbox'
import { agentImageKey, loadAgentImage } from '@/lib/agent-image-loader'

export const AgentImagePreviewContext = createContext<AgentImageResult | undefined>(undefined)

export function AgentImage({ query, alt, caption, compact = false }: { query: string; alt: string; caption?: string; compact?: boolean }) {
  const agentCopy = useAgentCopy()

  const previewImage = useContext(AgentImagePreviewContext)
  const { data, error, isLoading, mutate } = useSWR(previewImage ? null : agentImageKey(query), loadAgentImage, { revalidateOnFocus: false, shouldRetryOnError: false })
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  if (isLoading) return <figure className="flex min-w-0 flex-col gap-2" aria-busy="true" aria-label={alt}><Skeleton className="aspect-video w-full rounded-xl" /></figure>
  const image = previewImage ?? data?.image
  if (error || (image && failedSrc === image.src)) return <Alert><AlertDescription>{agentCopy.unableToLoadThisImage}<Button type="button" variant="outline" size="sm" onClick={() => { setFailedSrc(null); void mutate() }}>{agentCopy.retryImage}</Button></AlertDescription></Alert>
  if (!image) return <p className="text-xs text-muted-foreground">{agentCopy.noImageFoundForundefined}{query}{agentCopy.text}</p>
  return <figure className="flex min-w-0 flex-col gap-2">
    <ImageViewer images={[{ id: image.source, src: image.src, alt, width: image.width, height: image.height, caption: caption ?? image.title }]} label={agentCopy.illustrationViewer}>
      <AspectRatio ratio={16 / 9} animated={false} className="rounded-xl">
        <ImageViewerThumbnail loading="eager" imageId={image.source} aria-label={(agentCopy.enlarge + (alt))} className="size-full rounded-none" imageClassName="size-full object-cover" onErrorCapture={() => setFailedSrc(image.src)} />
      </AspectRatio>
      <ImageViewerContent><ImageViewerCaption /></ImageViewerContent>
    </ImageViewer>
    <figcaption className="flex flex-col gap-1 text-xs text-muted-foreground">
      {caption && <span>{caption}</span>}
      {previewImage ? <span>{agentCopy.localDemoPlaceholderNotASourceImage}</span> : compact ? <Collapsible>
        <CollapsibleTrigger render={<Button type="button" variant="link" size="sm" />}>{agentCopy.imageSourceAndLicense}</CollapsibleTrigger>
        <CollapsibleContent><a href={image.source} target="_blank" rel="noopener noreferrer" className="break-words underline underline-offset-4">Wikimedia Commons · {image.title}{image.author ? ` · ${image.author}` : ''} · {image.license}</a></CollapsibleContent>
      </Collapsible> : <a href={image.source} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">Wikimedia Commons · {image.title}{image.author ? ` · ${image.author}` : ''} · {image.license}</a>}
    </figcaption>
  </figure>
}
