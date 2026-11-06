import { createElement, lazy, Suspense, type ComponentType } from 'react'

/** Keep the same existing lazy components and their exact loading boundaries. */
export default function dynamic<Props extends object>(loader: () => Promise<ComponentType<Props> | { default: ComponentType<Props> }>, options?: { loading?: ComponentType; ssr?: boolean }) {
  const Component = lazy(async () => {
    const result = await loader()
    return { default: typeof result === 'function' ? result : result.default }
  })
  return function LocalDynamic(props: Props) {
    return <Suspense fallback={options?.loading ? createElement(options.loading) : null}><Component {...props} /></Suspense>
  }
}
