// Type-only contract for a clean source checkout. Production build.mjs emits
// spa.ts from the actual Vite index before Nitro can resolve this runtime import.
// This declaration provides no HTML and cannot stand in for the required build.
export declare const spaHtml: string
