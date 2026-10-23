"use client";

import { useCallback, useSyncExternalStore } from "react";

/** Subscribes to a CSS media query. `serverValue` is used during SSR/hydration. */
export function useMediaQuery(query: string, serverValue = false) {
  const subscribe = useCallback((onChange: () => void) => {
    const mq = window.matchMedia(query);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => serverValue);
}
