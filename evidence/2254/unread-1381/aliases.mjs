import {registerHooks} from 'node:module'
import {pathToFileURL} from 'node:url'
import {apiAliases} from '../../../../apps/api/compat-aliases.mjs'
registerHooks({resolve(specifier, context, nextResolve) {
  if(Object.hasOwn(apiAliases,specifier)&&specifier!=='@')return {url:pathToFileURL(apiAliases[specifier]).href,shortCircuit:true}
  return nextResolve(specifier,context)
}})
