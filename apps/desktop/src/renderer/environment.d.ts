// Shared action return types reference Next's RequestInit extension. This is
// types only; the runtime bundle rejects all server modules.
/// <reference types="next" />

declare module 'mikka:native-offline' {
  export const paths: { network: string[]; server: string[] }
}

declare module 'mikka:renderer-build' {
  export const rendererBuild: string
}

declare module 'mikka:frontend-runtime' {}

declare module 'mikka:platform' {
  export const platform: 'desktop' | 'web'
  export const AuthForm: typeof import('./auth-form').AuthForm
  export const BrowserRoute: typeof import('./platform').BrowserRoute
  export const setSession: typeof import('./auth-client').setSession
  export const onSessionChanged: typeof import('./platform').onSessionChanged
  export const authenticatedReturn: typeof import('./platform').authenticatedReturn
  export const bootstrapScope: typeof import('./platform').bootstrapScope
  export const PlatformExtras: typeof import('./platform').PlatformExtras
  export const requireUpdate: typeof import('./platform').requireUpdate
}
