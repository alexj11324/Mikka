"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/**
 * motion's `useReducedMotion`, safe to hydrate. motion reads the media query
 * in the first client render, so with reduced motion on the client draws other
 * styles than the server did. This reports false while hydrating, then the
 * real preference; a component mounted later reads it straight away.
 */
export function useReducedMotion() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
