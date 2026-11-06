import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {constants,createCipheriv,createHash,createPublicKey,publicEncrypt,randomBytes} from 'node:crypto';

export const NAMES = Object.freeze(['AI_GATEWAY_API_KEY', 'ZEROCAT_BASE_URL', 'ZEROCAT_API_KEY']);
export const PUBLIC_KEY = "-----BEGIN PUBLIC KEY-----\nMIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAmBWkRYUsBds+jC1QMssd\nxLmswwoely3xA7vO/mZlCxTFwtkvP49jd4WiIOAF6E6loH1ZdoOdB8h6Dq5Yw4HR\nBIMTrTX62CaPeMOed/bnSiTipk0lCcPJXdy7uKKENVQWIyTi9KoDIq0jwBzD6xvS\nhwSk6ata37nR6m18jDspNoXrvMWjfYRLxfkz4lV6uvQ7wUIpO9UFeCBHZi1NfqwD\nZmwSLARHWG/CeqT+ot6vyxWVc4uhtwScM0kHJ/kXeR2dkJnaBmcDKJvio1s0h45u\nbSlLvzt/dkdIONp3fNX0+RJWB55pUCnVBsozD8k8Zo2jIeT3Mj/rmQwsKQY34/7l\nBwugm9ru08hZm7JtaIlHe3/h3rqYCau3J4xpMIN75T38yzgJTM2fTK90MZs3VCyY\nFdYO1b1zW+raRJETrzKXs7YXTBHNLVJjNrygnhpmS3XcMlcU01XvRcdPGUztdM+q\nIxm29EexRC8boFidwJmKP75wNnfQnYvg7hbSgq2UuCFvAgMBAAE=\n-----END PUBLIC KEY-----\n";
export const fingerprint = key => createHash('sha256').update(createPublicKey(key).export({type:'spki',format:'der'})).digest('hex');
export const REQUEST = Object.freeze({...{
  "schema": 1,
  "purpose": "issue1415-isolated-model-credentials",
  "repository": "alexj11324/Mikka",
  "repositoryId": "1427517699",
  "repositoryOwnerId": "183887963",
  "ref": "refs/heads/ops/issue1415-model-credentials",
  "targetSandbox": "sandboxes/sbx_001m6p8qt9pcng01mwgkmshdz6m",
  "targetOrigin": "https://3000-001m6p8qt9pcng01mwgkmshdz6m.sbx.sandboxes-cloud.docker.com",
  "requestNonce": "fdaf4582-024e-4c9c-ac73-f667c1461290",
  "requestedAt": "2026-11-06T12:47:11.996Z",
  "requestExpiresAt": "2026-11-06T14:47:11.996Z"
},recipientFingerprint:fingerprint(PUBLIC_KEY)});
export const ALGORITHM = 'RSA-OAEP-SHA256+AES-256-GCM';
export const MAX_VALUE_BYTES = 65536;
export const PACKAGE_TTL_MS = 30 * 60 * 1000;
const OUTCOMES = new Set(['success','failure','cancelled','skipped']);

export function reject(code) { throw Object.assign(new Error(code),{code}); }
export function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) reject('CREDENTIAL_SHAPE_REJECTED');
}
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export function present(value) {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value,'utf8') <= MAX_VALUE_BYTES;
}
export function validateContext(context) {
  exactKeys(context,['sourceSha','runId','runAttempt']);
  if (!/^[a-f0-9]{40}$/.test(context.sourceSha) || !/^[1-9][0-9]{0,19}$/.test(context.runId) ||
      !/^[1-9][0-9]{0,5}$/.test(context.runAttempt)) reject('CREDENTIAL_CONTEXT_REJECTED');
}
export function delivery(presence) {
  return {deliveryReady:presence.AI_GATEWAY_API_KEY,zeroCatPairComplete:presence.ZEROCAT_BASE_URL && presence.ZEROCAT_API_KEY};
}
export function sealCredentials({values,outcomes,context,now=Date.now(),request=REQUEST,publicKey=PUBLIC_KEY}) {
  exactKeys(values,NAMES); exactKeys(outcomes,NAMES); validateContext(context);
  if (!Number.isFinite(now) || now < Date.parse(request.requestedAt) - 60000 ||
      now >= Date.parse(request.requestExpiresAt)) reject('CREDENTIAL_REQUEST_EXPIRED');
  const key=createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 3072 ||
      fingerprint(publicKey) !== request.recipientFingerprint) reject('CREDENTIAL_RECIPIENT_REJECTED');
  const credentials={}; const presence={};
  for (const name of NAMES) {
    if (!OUTCOMES.has(outcomes[name])) reject('CREDENTIAL_OUTCOME_REJECTED');
    const value=values[name];
    if (value !== undefined && typeof value !== 'string') reject('CREDENTIAL_VALUE_REJECTED');
    if (value !== undefined && Buffer.byteLength(value,'utf8') > MAX_VALUE_BYTES) reject('CREDENTIAL_VALUE_REJECTED');
    presence[name]=present(value);
    if (presence[name] && outcomes[name] !== 'success') reject('CREDENTIAL_OUTCOME_REJECTED');
    if (presence[name]) credentials[name]=value;
  }
  const aad={...request,...context,algorithm:ALGORITHM,issuedAt:new Date(now).toISOString(),
    expiresAt:new Date(Math.min(now+PACKAGE_TTL_MS,Date.parse(request.requestExpiresAt))).toISOString(),
    presence,outcomes};
  const aesKey=randomBytes(32); const iv=randomBytes(12);
  const plaintext=Buffer.from(canonical({schema:1,credentials}),'utf8');
  try {
    const cipher=createCipheriv('aes-256-gcm',aesKey,iv,{authTagLength:16});
    cipher.setAAD(Buffer.from(canonical(aad),'utf8'));
    const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
    const wrappedKey=publicEncrypt({key,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256',
      oaepLabel:Buffer.from(request.requestNonce,'utf8')},aesKey);
    return {schema:1,aad,wrappedKey:wrappedKey.toString('base64'),iv:iv.toString('base64'),
      tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};
  } finally { aesKey.fill(0); plaintext.fill(0); }
}
function githubContext(env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'push' ||
      env.GITHUB_REPOSITORY !== REQUEST.repository || env.GITHUB_REPOSITORY_ID !== REQUEST.repositoryId ||
      env.GITHUB_REPOSITORY_OWNER_ID !== REQUEST.repositoryOwnerId || env.GITHUB_REF !== REQUEST.ref ||
      env.GITHUB_REF_TYPE !== 'branch' ||
      env.GITHUB_WORKFLOW_REF !== REQUEST.repository+'/.github/workflows/issue1415-model-credentials.yml@'+REQUEST.ref ||
      env.GITHUB_WORKFLOW_SHA !== env.GITHUB_SHA) reject('CREDENTIAL_RUN_CONTEXT_REJECTED');
  const context={sourceSha:env.GITHUB_SHA,runId:env.GITHUB_RUN_ID,runAttempt:env.GITHUB_RUN_ATTEMPT};
  validateContext(context); return context;
}
function writeExclusive(file,value) {
  const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  try {fs.writeFileSync(fd,value);fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
}
export function run() {
  process.umask(0o077);
  const context=githubContext(process.env);
  const values=Object.fromEntries(NAMES.map(name=>[name,process.env[name]]));
  for (const name of NAMES) delete process.env[name];
  const outcomes={AI_GATEWAY_API_KEY:process.env.READ_GATEWAY_OUTCOME,ZEROCAT_BASE_URL:process.env.READ_ZEROCAT_BASE_OUTCOME,ZEROCAT_API_KEY:process.env.READ_ZEROCAT_KEY_OUTCOME};
  const envelope=sealCredentials({values,outcomes,context});
  const body=JSON.stringify(envelope,null,2)+'\n';
  const report={schema:1,requestNonce:REQUEST.requestNonce,recipientFingerprint:REQUEST.recipientFingerprint,
    repository:REQUEST.repository,ref:REQUEST.ref,...context,targetSandbox:REQUEST.targetSandbox,
    issuedAt:envelope.aad.issuedAt,expiresAt:envelope.aad.expiresAt,presence:envelope.aad.presence,
    readOutcomes:outcomes,...delivery(envelope.aad.presence),envelopeSha256:createHash('sha256').update(body).digest('hex'),
    plaintextArtifact:false,modelRequests:0,productionMutations:0};
  const root=path.resolve('issue1415-model-credentials-sealed');
  fs.mkdirSync(root,{mode:0o700});
  writeExclusive(path.join(root,'envelope.json'),body);
  writeExclusive(path.join(root,'report.json'),JSON.stringify(report,null,2)+'\n');
  if (!process.env.GITHUB_OUTPUT) reject('CREDENTIAL_OUTPUT_CHANNEL_MISSING');
  fs.appendFileSync(process.env.GITHUB_OUTPUT,'delivery_ready='+String(report.deliveryReady)+'\n');
  // Public output is deliberately limited to presence and a fixed disposition.
  console.log(JSON.stringify({status:'sealed',presence:report.presence,deliveryReady:report.deliveryReady,
    zeroCatPairComplete:report.zeroCatPairComplete,plaintextArtifact:false}));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {run();} catch(error) {
    const code=typeof error?.code === 'string' && /^CREDENTIAL_[A-Z0-9_]+$/.test(error.code) ? error.code : 'CREDENTIAL_SEAL_FAILED';
    console.error(JSON.stringify({status:'failed',code})); process.exitCode=1;
  }
}
