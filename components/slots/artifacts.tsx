'use client'

/**
 * The Artifact page's body. The open-source UI draws the shared library; a UI
 * layer may draw its own from the same props (docs/ui-overlay.md).
 */
import { ArtifactLibrary } from '@/components/artifacts/artifact-library'
import type { ArtifactsPageProps } from './artifacts-contract'

export function ArtifactsPage(_props: ArtifactsPageProps) {
  return <ArtifactLibrary />
}
