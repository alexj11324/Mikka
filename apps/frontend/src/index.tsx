// Runtime selection happens before the shared application is imported. Web
// instrumentation installs deployment-aware fetch and analytics first.
import 'mikka:frontend-runtime'
await import('../../desktop/src/renderer/index')
