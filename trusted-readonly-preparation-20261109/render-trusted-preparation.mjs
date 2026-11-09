export function rebindReadonlyPreparation(base, p, hashText) {
  const old={source:"a2198c8c2f608f7b8169329b9da853067618dba6",tree:"d3c86f905a0ff548720f54a9c73bf92a4764e033",branch:"ops/1505-smoke-github-fresh-20261109",go:"root-reviewed-1505-github-fresh-v2",deadline:"2026-11-09T10:45:00+00:00"};
  const digests={"github-readonly-provider.mjs":"11b100e92c24d91b98200c18eea9a50a9c6a09ac3e3d5ece1166bbcc559f8937","github-readonly-helper.mjs":"9655772777836a8b1a806b1021409ff9b1f7163db51490f25eeda166f6599be7","github-readonly-store.mjs":"1431219596ce2241f65f01df6642f0145c7f4c3b00f31181fefbc332ad9511d5","github-readonly-runner.mjs":"27c134bbc3fac43f8e64d245e23f2ea6c7188d6fee131cefc63195ebea900570","github-readonly.test.mjs":"91f42d23d47de871afce03788314fe505fad9083787434d1d380e771c26d4987"};
  if(hashText(base.workflow)!=="55f55ef0bf67658832516213d7b97c6aab497260f6260c23f6c1db8a838d2daa")throw Error("base workflow mismatch");
  if(Object.keys(base.files).sort().join("\n")!==Object.keys(digests).sort().join("\n"))throw Error("base file inventory mismatch");
  for(const [name,hash]of Object.entries(digests))if(hashText(base.files[name])!==hash)throw Error("base source mismatch:"+name);
  if(!/^[a-f0-9]{40}$/.test(p.source)||!/^[a-f0-9]{40}$/.test(p.tree))throw Error("source binding invalid");
  if(!/^ops\/1505-[a-z0-9-]+$/.test(p.branch)||p.branch===old.branch)throw Error("new unique branch required");
  if(!/^root-reviewed-1505-[a-z0-9-]+$/.test(p.go)||p.go===old.go)throw Error("new GO required");
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/.test(p.deadline)||!Number.isFinite(Date.parse(p.observedAt))||!(Date.parse(p.deadline)>Date.parse(p.observedAt))||Date.parse(p.deadline)-Date.parse(p.observedAt)>2*60*60*1000)throw Error("bounded new deadline invalid");
  const replace=(s,a,b,n)=>{if(s.split(a).length-1!==n)throw Error("literal count mismatch:"+a);return s.split(a).join(b);};
  const files={...base.files};
  for(const name of ["github-readonly-runner.mjs","github-readonly.test.mjs"]){
    files[name]=replace(replace(files[name],old.branch,p.branch,1),old.go,p.go,1);
    if(replace(replace(files[name],p.branch,old.branch,1),p.go,old.go,1)!==base.files[name])throw Error("nonbinding JS change");
  }
  let workflow=base.workflow;
  const counts={source:7,tree:1,branch:3,go:2,deadline:6};
  for(const [key,count]of Object.entries(counts))workflow=replace(workflow,old[key],p[key],count);
  const hashes=Object.fromEntries(Object.entries(files).map(([name,s])=>[name,hashText(s)]));
  for(const name of ["github-readonly-runner.mjs","github-readonly.test.mjs"])workflow=replace(workflow,digests[name],hashes[name],1);
  let reversed=workflow;
  for(const name of ["github-readonly-runner.mjs","github-readonly.test.mjs"])reversed=replace(reversed,hashes[name],digests[name],1);
  for(const [key,count]of Object.entries(counts))reversed=replace(reversed,p[key],old[key],count);
  if(reversed!==base.workflow)throw Error("nonbinding workflow change");
  return {workflow,files,bindings:p,sourceSha256:hashes,checks:{baselineHashes:true,exactLiteralCounts:counts,inverseFullBytes:true,productDelta:false,published:false,triggered:false}};
}

export function renderTrustedReadonlyPreparation(base,p,hashText,rebind) {
 if(p.branch!=="ops/1505-smoke-github-readonly-20261109")throw Error("historically verified subject required");
 if(!/^[a-f0-9]{40}$/.test(p.closedOpsHead??"")||p.closedOpsHead===p.source)throw Error("closed OPS parent invalid");
 const rendered=rebind(base,p,hashText);
 const once=(s,a,b)=>{if(s.split(a).length!==2)throw Error("trusted anchor missing or repeated");return s.replace(a,b);};
 const before=rendered.workflow;
 const parentOld=`          assert git('rev-list','--parents','-n','1','HEAD').split()[1:]==['${p.source}']`;
 const parentNew=`          assert git('rev-list','--parents','-n','1','HEAD').split()[1:]==['${p.source}','${p.closedOpsHead}']`;
 const scopeOld=`          assert set(git('diff','--name-only','${p.source}','HEAD').splitlines())==allowed`;
 const scopeNew=scopeOld+`
          raw=git('diff','--raw','--no-renames','--abbrev=40','${p.source}','HEAD').splitlines()
          entries=[line.split('\\t',1) for line in raw]
          assert len(entries)==len(allowed) and all(len(entry)==2 for entry in entries)
          assert {entry[1] for entry in entries}==allowed
          for header,path in entries:
              fields=header.split()
              assert len(fields)==5 and fields[0]==':000000' and fields[1]=='100644' and fields[4]=='A',path`;
 const jobOld="    runs-on: ubuntu-latest\n    timeout-minutes: 15";
 const jobNew="    runs-on: ubuntu-latest\n    concurrency:\n      group: web-deploy-production\n      cancel-in-progress: false\n      queue: max\n    timeout-minutes: 15";
 let workflow=once(once(once(before,parentOld,parentNew),scopeOld,scopeNew),jobOld,jobNew);
 const oldComment="# A new, bounded ref may be published only after current shared-account/writer review.";
 const newComment="# A new, bounded entry may be published only after current shared-account/writer review.";
 workflow=once(workflow,oldComment,newComment);
 let inverse=once(once(once(once(workflow,newComment,oldComment),jobNew,jobOld),scopeNew,scopeOld),parentNew,parentOld);
 if(inverse!==before)throw Error("unexpected trusted workflow delta");
 return {...rendered,workflow,checks:{...rendered.checks,exactOrderedParents:[p.source,p.closedOpsHead],addedRegularFilesOnly:true,smokeAndWebQueues:true,businessLogicUnchanged:true,historicalSubjectReused:true,needsNewGitGuardExecution:true,published:false,triggered:false}};
}
