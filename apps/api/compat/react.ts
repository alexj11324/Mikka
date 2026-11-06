// This alias is confined to the independent server graph. Existing React
// renderers keep the original package; only server cache needs an ALS owner.
import React from 'mikka-real-react'
export default React
// Re-export the real public implementation; only cache gets request semantics.
// Explicit exports also type-check against React's export= declaration.
export const { Children, Fragment, Profiler, StrictMode, Suspense, Component, PureComponent,
  cloneElement, createContext, createElement, createRef, forwardRef, isValidElement, lazy, memo,
  startTransition, use, useActionState, useCallback, useContext, useDebugValue, useDeferredValue,
  useEffect, useId, useImperativeHandle, useInsertionEffect, useLayoutEffect, useMemo,
  useOptimistic, useReducer, useRef, useState, useSyncExternalStore, useTransition, version } = React
export type { ReactNode, ReactElement, ComponentProps, ComponentType, RefObject, CSSProperties } from 'mikka-real-react'
export { requestCache as cache } from '../src/context'
