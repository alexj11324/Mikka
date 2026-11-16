from pathlib import Path
import json,sys
base=Path(sys.argv[1])
p=base/'run/case/proof.json'
proof=json.loads(p.read_text()) if p.exists() else {}
allowed=('phase','at','step','status','state','version','actualGoogleOAuth','packagedDesktop')
checks=[{k:v for k,v in step.items() if k in allowed} for step in proof.get('checks',[])]
result={'source':(base/'source.sha').read_text().strip(),'interface':'real-system-chrome-pkce-and-owner-lease-cleanup','observed':checks,'scenarioExit':int((base/'run/case/exit').read_text()) if (base/'run/case/exit').exists() else None,'stage':(proof.get('diagnostic') or {}).get('stage')}
required=[('native_logout_invalidates_original_owner_revoke','status',401),('same_lease_owner_reauthenticated',None,None),('device_credential_revoked',None,None),('same_lease_same_owner_fresh_session_revokes_real_device',None,None),('second_owner_logout_before_independent_lease_release',None,None),('device_revoke_rejected','status',401),('cleanup_failed','step','device_credential'),('lease_closed','state','quarantined')]
actual={c['phase']:c for c in checks}
result['pass']=all(name in actual and (key is None or actual[name].get(key)==expected) for name,key,expected in required) and result['scenarioExit']==1 and not proof.get('diagnostic') and not proof.get('success')
print(json.dumps(result,indent=2))
if not result['pass']: sys.exit(1)
