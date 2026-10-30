import { githubRepository } from '../../../lib/github/run-pull-request'
import type { CiPollLease } from './ci-poller'

/** Recheck the linked person's live GitHub access on every poll without
 * exposing the App signing key to the Worker. */
export async function verifyScopedCiAccess(lease:CiPollLease,token:string,signal:AbortSignal,fetcher:typeof fetch=fetch) {
  const b=lease.binding
  if(!b||!/^[1-9][0-9]*$/.test(b.githubAccountId))throw Error('CI access unavailable')
  const repo=githubRepository(b.remoteKey)
  const get=async(path:string)=>{
    const response=await fetcher(`https://api.github.com${path}`,{headers:{accept:'application/vnd.github+json',authorization:`Bearer ${token}`,'x-github-api-version':'2022-11-28'},redirect:'error',signal})
    if(!response.ok)throw Error('CI access unavailable')
    return response.json()
  }
  const person=await get(`/user/${b.githubAccountId}`) as {id?:unknown;login?:unknown}
  if(String(person.id)!==b.githubAccountId||typeof person.login!=='string'||!/^[a-z0-9-]+$/i.test(person.login))throw Error('CI access unavailable')
  const permission=await get(`${repo.path}/collaborators/${encodeURIComponent(person.login)}/permission`) as {permission?:unknown;user?:{id?:unknown}}
  if(String(permission.user?.id)!==b.githubAccountId||!['admin','write'].includes(String(permission.permission)))throw Error('CI access unavailable')
  const repository=await get(repo.path) as {id?:unknown;full_name?:unknown}
  if(repository.id!==b.repositoryId||typeof repository.full_name!=='string'||repository.full_name.toLowerCase()!==`${repo.owner}/${repo.repo}`.toLowerCase())throw Error('CI access unavailable')
}
