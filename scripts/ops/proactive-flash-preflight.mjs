import { withTemporaryFlashCredential } from './proactive-test-credentials.mjs'
let cleanup
try { await withTemporaryFlashCredential(async receipt => { cleanup = receipt; await import('./proactive-account-preflight.mjs') }, {cloudExecution:true}) }
catch(error) { console.log(JSON.stringify({status:'fail',error:/^acceptance_[a-z_]+$/.test(error?.message??'')?error.message:'acceptance_setup_failed'})); process.exitCode=1 }
finally { if(cleanup) console.log(JSON.stringify({credentialCleanup:cleanup})) }
