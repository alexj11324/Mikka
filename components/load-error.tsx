import { Button } from '@/components/ui/button'

/** A list that failed to load: one line of error text and a retry button, the same everywhere. */
export function InlineLoadError({ message, retryLabel, onRetry }: { message: string; retryLabel: string; onRetry: () => void }) {
  return <div role="alert" className="flex items-center gap-2 text-xs"><span className="text-destructive">{message}</span><Button variant="ghost" size="xs" onClick={onRetry}>{retryLabel}</Button></div>
}
