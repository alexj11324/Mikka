import { prepareAuditDisposal } from '../lib/audit/disposal-session';
const [plan,output]=process.argv.slice(2);
if(!plan||!output||!process.env.AUDIT_APP_TEST_URL) throw new Error('Explicit private plan, new manifest path and dedicated audit database required');
void prepareAuditDisposal(plan,output,process.env.AUDIT_APP_TEST_URL).then(()=>console.log('Audit fixture prepared and retained; no deletion executed. Separate exact-manifest approval required.')).catch(()=>{console.error('Audit preparation failed; retain any created fixtures and inspect locally.');process.exitCode=1;});
