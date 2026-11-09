import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
mkdirSync('acceptance-results',{recursive:true});
const path='acceptance-results/diagnostic-window-cleanup.json';
if(!existsSync(path))writeFileSync(path,JSON.stringify({version:1,issue:1505,status:'not_attempted',code:'cleanup_prerequisite_failed',cleanupAttempted:false,projectEnvironmentRemoved:false,activeDeploymentRevoked:false},null,2)+'\n',{mode:0o600});
