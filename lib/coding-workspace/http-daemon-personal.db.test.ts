import { registerHTTPDaemonAcceptance } from '../../tests/support/coding-workspace-http-daemon'

// A separate test worker keeps module-level DB/auth state isolated from the
// existing shared case while exercising the exact same transport fixture.
registerHTTPDaemonAcceptance('personal')
