// Test-only: `lib/server-runtime/react.ts` imports the real React package under
// the `mikka-real-react` specifier so the API graph can alias bare `react` to
// the shim itself. TypeScript resolves that specifier through tsconfig paths,
// which never applies at runtime — and `tsx` applies those paths too, resolving
// the specifier to React's declaration file before this hook runs. So inspect
// what the next resolver produced and swap a type-only hit for the real package.
// Only the runtime-entrypoint test opts into this; every other suite keeps its
// own graph.
import { registerHooks } from 'node:module'

const realReact = import.meta.resolve('react')

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context)
    if (specifier === 'mikka-real-react' || resolved.url.endsWith('/@types/react/index.d.ts')) {
      return { url: realReact, shortCircuit: true }
    }
    return resolved
  },
})
