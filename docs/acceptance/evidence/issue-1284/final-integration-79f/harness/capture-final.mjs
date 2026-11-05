// Real-page screenshot capture only: normal TestAccountPool state consumed by
// Chromium in this sandbox. No browser suite, mocked HTTP, Send or model request.
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
const config=JSON.parse(await readFile(process.env.MIKKA_FINAL_CONFIG,'utf8'));
const root=resolve(config.root),prefix=config.prefix;
if(!/^\/tmp\/issue1284-[a-z0-9-]+$/.test(prefix))throw Error('INVALID_CAPTURE_PREFIX');
const metadataBytes=await readFile(prefix+'-visual-state.json');
const fixture=JSON.parse(metadataBytes.toString('utf8'));
const origin=new URL(fixture.origin);
if(origin.protocol!=='http:'||origin.hostname!=='localhost'||origin.port!=='3110')throw Error('CAPTURE_REQUIRES_LOOPBACK_NEXT');
if(fixture.sourceCommit!==config.sourceCommit||fixture.sourceTree!==config.sourceTree)throw Error('CAPTURE_SOURCE_MISMATCH');
const profiles=fixture.pickerFixture;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if(!uuid.test(profiles?.checkingProfile?.id)||!uuid.test(profiles?.unavailableProfile?.id))throw Error('CAPTURE_PROFILE_METADATA_MISSING');
const privateState=await stat(fixture.statePath);
if(!privateState.isFile()||(privateState.mode&0o077)!==0)throw Error('BROWSER_STATE_MUST_REMAIN_PRIVATE');
const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
const sourceOk=()=>git('rev-parse','HEAD')===config.sourceCommit&&git('rev-parse','HEAD^{tree}')===config.sourceTree&&!git('status','--porcelain','--untracked-files=no');
if(!sourceOk())throw Error('CAPTURE_SOURCE_NOT_CLEAN_EXACT_HEAD');
const buildId=(await readFile(join(root,'.next/BUILD_ID'),'utf8')).trim();
const messages=JSON.parse(await readFile(join(root,'messages/zh-CN.json'),'utf8'));
const require=createRequire(join(root,'package.json')),{chromium}=require('@playwright/test');
const output=prefix+'-screenshots';await mkdir(output,{recursive:true,mode:0o700});
const startedAt=new Date().toISOString(),captures=[];
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox']});
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
try{
 for(const [theme,width,height] of [['light',1440,1000],['dark',1440,1000],['light',390,844],['dark',390,844]]){
  const context=await browser.newContext({storageState:fixture.statePath,viewport:{width,height},colorScheme:theme,deviceScaleFactor:1,hasTouch:width===390,isMobile:width===390});
  try{
   await context.addInitScript(value=>localStorage.setItem('theme',value),theme);
   const page=await context.newPage();
   await page.goto(origin.origin+'/mikka/zh-CN?section=all-issues',{waitUntil:'networkidle',timeout:30000});
   const create=page.getByRole('button',{name:messages.Nav.newTask,exact:true}).last();
   await create.waitFor({state:'visible',timeout:30000});await create.click();
   const dialog=page.getByRole('dialog');
   await dialog.getByPlaceholder(messages.Shell.newTaskDialog.placeholder).fill('隔离界面演示：整理任务界面的留白与颜色，不发送本次草稿。');
   const trigger=dialog.getByRole('combobox',{name:messages.Settings.agentProfiles.taskProfile,exact:true});
   await trigger.waitFor({state:'visible',timeout:30000});await trigger.click();
   const checking=page.getByRole('option',{name:new RegExp(escape(profiles.checkingProfile.name))});
   await checking.waitFor({state:'visible',timeout:30000});await checking.click();
   const status=dialog.getByRole('status').filter({hasText:messages.Settings.agentProfiles.reasons.checking});
   await status.waitFor({state:'visible',timeout:30000});
   await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(800);
   const selection={triggerText:await trigger.innerText(),noticeText:await status.innerText(),createButtonDisabled:await dialog.getByRole('button',{name:messages.Shell.newTaskDialog.create,exact:true}).isDisabled()};
   async function capture(state,observations){
    const layout=await page.evaluate(()=>({viewportWidth:innerWidth,viewportHeight:innerHeight,documentWidth:document.documentElement.scrollWidth}));
    const filename=config.sourceCommit.slice(0,12)+'-profile-picker-'+state+'-'+theme+'-'+width+'.png',path=join(output,filename);
    await page.screenshot({path,fullPage:true});const bytes=await readFile(path);
    captures.push({filename,path,theme,state,viewport:{width,height},layout,pageUrl:page.url(),observations,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),capturedAt:new Date().toISOString()});
   }
   await capture('selected',selection);
   await trigger.click();
   const unavailable=page.getByRole('option',{name:new RegExp(escape(profiles.unavailableProfile.name))});
   await unavailable.waitFor({state:'visible',timeout:30000});await page.waitForTimeout(800);
   await capture('menu',{...selection,checkingOptionText:await checking.innerText(),checkingAriaDisabled:await checking.getAttribute('aria-disabled'),unavailableOptionText:await unavailable.innerText(),unavailableAriaDisabled:await unavailable.getAttribute('aria-disabled')});
  }finally{await context.close();}
 }
}finally{await browser.close();}
if(!sourceOk())throw Error('CAPTURE_SOURCE_CHANGED');
const receipt={kind:'normal-next-profile-picker-capture',sourceCommit:config.sourceCommit,sourceTree:config.sourceTree,buildId,startedAt,finishedAt:new Date().toISOString(),
 fixture:{checkingProfile:profiles.checkingProfile,unavailableProfile:profiles.unavailableProfile,disabledProfile:profiles.disabledProfile,availability:profiles.availability},
 authentication:'Normal TestAccountPool sign-in; its private storageState is consumed directly by Chromium inside the same Docker sandbox. No authentication bypass, cookie export or credential logging.',
 method:'Actual pnpm build/next start page. Screenshot-only navigation, fill, and Select interaction; no browser test suite, HTTP mocking, Send, task creation, worker or provider call.',
 readiness:'Initial navigation network requests settle before interacting with the hydrated board; real dialog, selection and status are visible; fonts ready and normal layout transitions settled. No style or animation override.',
 boundaries:['Synthetic isolated catalogue metadata is not a real subscription or native execution claim.','Checking permits client selection only; the server still authorizes actual dispatch.','Confirmed unavailable option is an enabled Codex Profile with no model source in the fixture, as returned by normal authenticated management GET.','Stale metadata priority is separately covered by the actual component regression, not a fabricated server response.'],
 browserClosed:true,contextsClosed:true,captures};
await writeFile(join(output,'capture-receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({sourceCommit:config.sourceCommit,sourceTree:config.sourceTree,captures:captures.map(({path,sha256})=>({path,sha256})),receipt:join(output,'capture-receipt.json'),browserClosed:true}));
